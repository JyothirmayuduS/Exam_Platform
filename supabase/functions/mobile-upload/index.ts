import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const formData = await req.formData().catch(() => null);
    if (!formData) {
      return new Response(JSON.stringify({ error: "Expected multipart/form-data" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Trim the token: QR readers occasionally append a trailing newline or
    // space to the URL segment, which previously made the exact-match lookup
    // fail with the misleading "Invalid or expired token".
    const token = (formData.get("token") as string ?? "").trim();
    // Human question number forwarded from the QR URL (falls back to question_id).
    const qId = (formData.get("qId") as string | null) || null;
    // Exam id forwarded from the QR URL — used for the storage folder when the
    // session's attempt is still the `pending_<studentId>` placeholder.
    const formExamId = ((formData.get("examId") as string | null) || "").trim() || null;
    const imageFiles: File[] = [];
    
    let i = 0;
    while (formData.has(`image_${i}`)) {
      imageFiles.push(formData.get(`image_${i}`) as File);
      i++;
    }
    
    if (imageFiles.length === 0 && formData.has("image")) {
      imageFiles.push(formData.get("image") as File);
    }

    if (!token || imageFiles.length === 0) {
      return new Response(JSON.stringify({ error: "Missing token or images" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Initialize Supabase Admin Client
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // 1. Verify Token
    // NOTE: we deliberately do NOT select `question_index` and do NOT embed
    // `attempts(exam_id)` here — both were silently breaking every scan:
    //  - `question_index` is not part of the documented schema, so referencing
    //    it makes the whole query error and every upload returned the
    //    misleading "Invalid or expired token".
    //  - `attempt_id` became TEXT (the `pending_<studentId>` placeholder), so
    //    the FK-based embed fails for those rows.
    // question_id is used for the PDF header instead, and exam_id is resolved
    // separately below.
    const { data: session, error: sessionError } = await supabaseAdmin
      .from("mobile_upload_sessions")
      .select("id, attempt_id, question_id, student_id, status, expires_at, used_at")
      .eq("token_hash", token)
      .maybeSingle();

    if (sessionError) {
      // The lookup itself failed (schema mismatch, RLS, network…) — surface the
      // real reason instead of masking it as a bad token.
      console.error("[mobile-upload] session lookup failed:", sessionError);
      return new Response(JSON.stringify({ error: `Upload session lookup failed: ${sessionError.message}` }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (!session) {
      return new Response(JSON.stringify({ error: "Invalid or expired token — scan a fresh QR code for this question" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (session.status !== "WAITING") {
      // A crashed phone or failed attempt can leave a session stuck in
      // PROCESSING. If it has been stale long enough, recover it so the
      // student's retry works instead of a permanent "already used" dead-end.
      // COMPLETED sessions are never reset.
      const staleProcessing =
        session.status === "PROCESSING" &&
        !!session.used_at &&
        Date.now() - new Date(session.used_at).getTime() > 10 * 60 * 1000;
      if (!staleProcessing) {
        return new Response(JSON.stringify({ error: "Session already used or processing — go back and refresh the exam page to generate a fresh upload link" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      await supabaseAdmin.from("mobile_upload_sessions").update({ status: "WAITING", used_at: null }).eq("id", session.id);
    }

    if (new Date(session.expires_at) < new Date()) {
      await supabaseAdmin.from("mobile_upload_sessions").update({ status: "EXPIRED" }).eq("id", session.id);
      return new Response(JSON.stringify({ error: "Session expired" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2. Mark session as processing
    await supabaseAdmin.from("mobile_upload_sessions").update({ status: "PROCESSING", used_at: new Date().toISOString() }).eq("id", session.id);

    // Resolve the exam id from the attempt when it is a real uuid (the
    // `pending_<studentId>` placeholder has no exam yet). Never via an embed.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let examId: string | null = null;
    if (session.attempt_id && UUID_RE.test(session.attempt_id)) {
      const { data: att } = await supabaseAdmin.from("attempts").select("exam_id").eq("id", session.attempt_id).maybeSingle();
      examId = att?.exam_id ?? null;
    }
    if (!examId && formExamId) examId = formExamId;
    const examFolder = examId ?? "no-exam"; // upload still succeeds when the attempt is still pending
    const bucketName = Deno.env.get("SUPABASE_BUCKET_NAME") || "exam-records";
    const ts = Date.now();

    // The submission row needs a REAL attempt uuid (FK to attempts). Sessions
    // created from the phone-side self-heal carry the `pending_` placeholder —
    // resolve the candidate's latest attempt for this exam instead, so the
    // upload lands in the gradeable attempt rather than erroring out.
    let submissionAttemptId: string | null =
      session.attempt_id && UUID_RE.test(session.attempt_id) ? session.attempt_id : null;
    if (!submissionAttemptId && session.student_id) {
      let q = supabaseAdmin
        .from("attempts")
        .select("id, exam_id")
        .eq("student_id", session.student_id)
        .order("started_at", { ascending: false })
        .limit(1);
      if (examId) q = q.eq("exam_id", examId);
      const { data: att } = await q.maybeSingle();
      if (att?.id) {
        submissionAttemptId = att.id as string;
        if (!examId && att.exam_id) examId = att.exam_id as string;
      }
    }

    let pdfPath = "";
    let firstOriginalPath = "";
    
    try {
      // Fetch student and exam details
      const { data: student } = await supabaseAdmin.from("students").select("full_name, roll").eq("id", session.student_id).maybeSingle();
      const { data: exam } = examId
        ? await supabaseAdmin.from("exams").select("name").eq("id", examId).maybeSingle()
        : { data: null } as { data: { name?: string } | null };

      const studentName = student?.full_name || session.student_id;
      const studentRoll = student?.roll || "UNKNOWN ROLL";
      const examName = exam?.name || "your exam";
      const courseCode = "";

      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const dateStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });

      for (let i = 0; i < imageFiles.length; i++) {
        const imageFile = imageFiles[i];
        const imageArrayBuffer = await imageFile.arrayBuffer();
        
        // 3. Store Original Image
        const originalPath = `${examFolder}/${session.student_id}/subjective/q${session.question_id}_${ts}_p${i+1}_original.jpg`;
        if (i === 0) firstOriginalPath = originalPath;
        
        await supabaseAdmin.storage.from(bucketName).upload(originalPath, imageArrayBuffer, {
          contentType: imageFile.type || "image/jpeg",
        });

        // 4. Generate PDF Page
        let pdfImage;
        if (imageFile.type === "image/png") {
          pdfImage = await pdfDoc.embedPng(imageArrayBuffer);
        } else {
          pdfImage = await pdfDoc.embedJpg(imageArrayBuffer);
        }

        const { width, height } = pdfImage.scale(1);
        const headerHeight = 130;
        const pageHeight = height + headerHeight;
        
        const page = pdfDoc.addPage([width, pageHeight]);
        
        // Draw the image at the bottom of the page
        page.drawImage(pdfImage, {
          x: 0,
          y: 0,
          width,
          height,
        });

        // --- Header Section ---
        const leftX = 40;
        const startY = pageHeight - 35; // start from top
        
        // Left Side: Student Details
        page.drawText(`STUDENT: ${studentName.toUpperCase()} (${studentRoll})`, {
          x: leftX,
          y: startY,
          size: 14,
          font,
          color: rgb(0, 0, 0),
        });
        
        page.drawText(`EXAM: ${examName.toUpperCase()} ${courseCode}`, {
          x: leftX,
          y: startY - 25,
          size: 14,
          font,
          color: rgb(0, 0, 0),
        });

        page.drawText(`QUESTION NO: ${qId || session.question_id}`, {
          x: leftX,
          y: startY - 50,
          size: 14,
          font,
          color: rgb(0, 0, 0),
        });
        
        page.drawText(`PAGE: ${i + 1} OF ${imageFiles.length}`, {
          x: leftX,
          y: startY - 75,
          size: 14,
          font,
          color: rgb(0, 0, 0),
        });

        // Right Side: Logo / Timestamp
        const rightX = Math.max(leftX + 250, width - 260); // Ensure it doesn't overlap on narrow images
        
        page.drawText(`VIGNAN UNIVERSITY`, {
          x: rightX,
          y: startY,
          size: 18,
          font,
          color: rgb(0.48, 0.12, 0.17), // Maroon color (#7A1F2B)
        });
        
        page.drawText(`OFFICIAL EXAM RECORD`, {
          x: rightX,
          y: startY - 20,
          size: 10,
          font,
          color: rgb(0.4, 0.4, 0.4),
        });

        page.drawText(`UPLOADED: ${dateStr}`, {
          x: rightX,
          y: startY - 45,
          size: 12,
          font,
          color: rgb(0.2, 0.2, 0.2),
        });
        
        // Draw a separator line
        page.drawRectangle({
          x: 0,
          y: height, // exact boundary between header and image
          width: width,
          height: 2,
          color: rgb(0, 0, 0),
        });
      }

      const pdfBytes = await pdfDoc.save();
      pdfPath = `${examFolder}/${session.student_id}/subjective/q${session.question_id}_${ts}.pdf`;
      
      await supabaseAdmin.storage.from(bucketName).upload(pdfPath, pdfBytes, {
        contentType: "application/pdf",
      });
    } catch (e) {
      console.error("PDF generation failed:", e);
      // Fallback: If PDF fails, we at least have the original image.
    }

    // 5. Create submission record (skipped only when the candidate genuinely
    // has no attempt row yet — the files are still stored and the session is
    // still completed, so the upload never hard-fails).
    if (submissionAttemptId) {
      await supabaseAdmin.from("question_submissions").insert({
        attempt_id: submissionAttemptId,
        question_id: session.question_id,
        student_id: session.student_id,
        original_storage_path: firstOriginalPath,
        pdf_storage_path: pdfPath || firstOriginalPath, // Fallback if PDF fails
        status: "COMPLETED",
        mime_type: pdfPath ? "application/pdf" : "image/jpeg",
        file_size: 0,
      });
    } else {
      console.warn("[mobile-upload] no real attempt row — files stored without a question_submissions record");
    }

    // 6. Complete Session (Triggers Realtime for Desktop)
    await supabaseAdmin.from("mobile_upload_sessions").update({ status: "COMPLETED" }).eq("id", session.id);

    return new Response(JSON.stringify({ ok: true, message: "Upload completed" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error(err);
    // Self-heal: a failed attempt must not permanently burn the token. If no
    // submission row was recorded yet, reset the session to WAITING so the
    // student's retry (client-side backoff or manual) can actually run.
    if (session?.id) {
      try {
        const { count } = await supabaseAdmin
          .from("question_submissions")
          .select("id", { count: "exact", head: true })
          .eq("attempt_id", submissionAttemptId ?? session.attempt_id)
          .eq("question_id", session.question_id);
        if (!count) {
          await supabaseAdmin.from("mobile_upload_sessions").update({ status: "WAITING", used_at: null }).eq("id", session.id);
        }
      } catch { /* best effort — leave the session as-is */ }
    }
    return new Response(JSON.stringify({ 
      error: err instanceof Error ? err.message : "Internal Server Error",
      stack: err.stack,
      name: err.name
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

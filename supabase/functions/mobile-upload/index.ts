import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, rgb, StandardFonts } from "https://cdn.skypack.dev/pdf-lib";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

    const token = formData.get("token") as string;
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
    const { data: session, error: sessionError } = await supabaseAdmin
      .from("mobile_upload_sessions")
      .select("id, attempt_id, question_id, student_id, status, expires_at, question_index, attempts(exam_id)")
      .eq("token_hash", token)
      .maybeSingle();

    if (sessionError || !session) {
      return new Response(JSON.stringify({ error: "Invalid or expired token" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (session.status !== "WAITING") {
      return new Response(JSON.stringify({ error: "Session already used or processing" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    if (new Date(session.expires_at) < new Date()) {
      await supabaseAdmin.from("mobile_upload_sessions").update({ status: "EXPIRED" }).eq("id", session.id);
      return new Response(JSON.stringify({ error: "Session expired" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // 2. Mark session as processing
    await supabaseAdmin.from("mobile_upload_sessions").update({ status: "PROCESSING", used_at: new Date().toISOString() }).eq("id", session.id);

    // @ts-ignore
    const examId = session.attempts?.exam_id;
    const bucketName = Deno.env.get("SUPABASE_BUCKET_NAME") || "exam-records";
    const ts = Date.now();

    let pdfPath = "";
    let firstOriginalPath = "";
    
    try {
      // Fetch student and exam details
      const { data: student } = await supabaseAdmin.from("students").select("full_name, roll").eq("id", session.student_id).maybeSingle();
      const { data: exam } = await supabaseAdmin.from("exams").select("name").eq("id", examId).maybeSingle();

      const studentName = student?.full_name || session.student_id;
      const studentRoll = student?.roll || "UNKNOWN ROLL";
      const examName = exam?.name || "EXAM-2026-014";
      const courseCode = "";

      const pdfDoc = await PDFDocument.create();
      const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
      const dateStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });

      for (let i = 0; i < imageFiles.length; i++) {
        const imageFile = imageFiles[i];
        const imageArrayBuffer = await imageFile.arrayBuffer();
        
        // 3. Store Original Image
        const originalPath = `${examId}/${session.student_id}/subjective/q${session.question_id}_${ts}_p${i+1}_original.jpg`;
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

        page.drawText(`QUESTION NO: ${session.question_index || session.question_id}`, {
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
      pdfPath = `${examId}/${session.student_id}/subjective/q${session.question_id}_${ts}.pdf`;
      
      await supabaseAdmin.storage.from(bucketName).upload(pdfPath, pdfBytes, {
        contentType: "application/pdf",
      });
    } catch (e) {
      console.error("PDF generation failed:", e);
      // Fallback: If PDF fails, we at least have the original image.
    }

    // 5. Create submission record
    await supabaseAdmin.from("question_submissions").insert({
      attempt_id: session.attempt_id,
      question_id: session.question_id,
      student_id: session.student_id,
      original_storage_path: firstOriginalPath,
      pdf_storage_path: pdfPath || firstOriginalPath, // Fallback if PDF fails
      status: "COMPLETED",
      mime_type: pdfPath ? "application/pdf" : "image/jpeg",
      file_size: 0,
    });

    // 6. Complete Session (Triggers Realtime for Desktop)
    await supabaseAdmin.from("mobile_upload_sessions").update({ status: "COMPLETED" }).eq("id", session.id);

    return new Response(JSON.stringify({ ok: true, message: "Upload completed" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error(err);
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

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: { headers: { Authorization: req.headers.get("Authorization")! } },
      }
    );

    const { url } = req;
    const urlObj = new URL(url);
    const examId = urlObj.searchParams.get("exam_id");

    if (!examId) {
      return new Response(JSON.stringify({ error: "exam_id is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data, error } = await supabaseClient
      .from("violation_events")
      .select(`
        created_at,
        violation_type,
        severity,
        description,
        student:students(roll, full_name)
      `)
      .eq("exam_id", examId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    let csv = "Timestamp,Student Roll,Student Name,Severity,Violation Type,Description\n";
    for (const row of (data || [])) {
      const student = row.student ? (Array.isArray(row.student) ? row.student[0] : row.student) : { roll: "Unknown", full_name: "Unknown" };
      const time = new Date(row.created_at).toLocaleString();
      const roll = student.roll;
      const name = student.full_name;
      const type = row.violation_type;
      const sev = row.severity;
      const desc = `"${(row.description || "").replace(/"/g, '""')}"`;
      
      csv += `${time},${roll},${name},${sev},${type},${desc}\n`;
    }

    return new Response(csv, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="proctor_log_${examId}.csv"`,
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

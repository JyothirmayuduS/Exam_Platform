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

    const [examRes, attemptsRes, violationsRes] = await Promise.all([
      supabaseClient.from("exams").select("*").eq("id", examId).single(),
      supabaseClient.from("attempts").select("id,state,score,student:students(roll,full_name)").eq("exam_id", examId),
      supabaseClient.from("violation_events").select("id,severity,violation_type").eq("exam_id", examId)
    ]);

    const examName = examRes.data?.name || "Exam Report";
    const totalStudents = attemptsRes.data?.length || 0;
    const submitted = attemptsRes.data?.filter(a => a.state === "submitted").length || 0;
    
    let highRisk = 0;
    let mediumRisk = 0;
    for (const v of (violationsRes.data || [])) {
      if (v.severity === "high" || v.severity === "critical") highRisk++;
      else if (v.severity === "low" || v.severity === "medium") mediumRisk++;
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Session Report - ${examName}</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; padding: 40px; max-width: 800px; margin: 0 auto; color: #333; }
          h1 { border-bottom: 2px solid #e2e8f0; padding-bottom: 10px; color: #1e293b; }
          .stats { display: flex; gap: 20px; margin-top: 30px; }
          .stat-box { flex: 1; padding: 20px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; text-align: center; }
          .stat-value { font-size: 24px; font-weight: bold; color: #0f172a; margin-bottom: 5px; }
          .stat-label { font-size: 14px; color: #64748b; }
          .section { margin-top: 40px; }
          h2 { color: #334155; font-size: 20px; margin-bottom: 15px; }
          table { width: 100%; border-collapse: collapse; margin-top: 15px; }
          th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
          th { background: #f1f5f9; color: #475569; font-weight: 500; font-size: 14px; }
          .critical { color: #ef4444; font-weight: 500; }
        </style>
      </head>
      <body>
        <h1>${examName} - Session Report</h1>
        <p>Generated on ${new Date().toLocaleString()}</p>
        
        <div class="stats">
          <div class="stat-box">
            <div class="stat-value">${totalStudents}</div>
            <div class="stat-label">Total Candidates</div>
          </div>
          <div class="stat-box">
            <div class="stat-value">${submitted}</div>
            <div class="stat-label">Submitted</div>
          </div>
          <div class="stat-box">
            <div class="stat-value critical">${highRisk}</div>
            <div class="stat-label">Critical Violations</div>
          </div>
        </div>
        
        <div class="section">
          <h2>Candidate Summary</h2>
          <table>
            <thead>
              <tr>
                <th>Roll Number</th>
                <th>Name</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${(attemptsRes.data || []).map(a => {
                const s = a.student ? (Array.isArray(a.student) ? a.student[0] : a.student) : { roll: 'Unknown', full_name: 'Unknown' };
                return `
                <tr>
                  <td>${s.roll}</td>
                  <td>${s.full_name}</td>
                  <td>${a.state === 'submitted' ? 'Completed' : 'In Progress'}</td>
                </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
        <script>
          // Automatically prompt print dialog when opened
          window.onload = () => window.print();
        </script>
      </body>
      </html>
    `;

    return new Response(html, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/html",
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

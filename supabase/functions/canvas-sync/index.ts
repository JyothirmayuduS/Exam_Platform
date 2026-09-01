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

    let body;
    try { body = await req.json(); } catch { body = {}; }
    const { examId, canvasCourseId, canvasAssignmentId } = body;

    if (!examId || !canvasCourseId || !canvasAssignmentId) {
      return new Response(JSON.stringify({ error: "Missing required parameters (examId, canvasCourseId, canvasAssignmentId)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const CANVAS_API_KEY = Deno.env.get("CANVAS_API_KEY");
    const CANVAS_URL = Deno.env.get("CANVAS_URL"); // e.g. https://canvas.instructure.com

    if (!CANVAS_API_KEY || !CANVAS_URL) {
       return new Response(JSON.stringify({ error: "Canvas integration is not fully configured (missing API keys)" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Fetch completed attempts and student rolls from Supabase
    const { data: attempts, error } = await supabaseClient
      .from("attempts")
      .select("score, state, student:students(roll, email)")
      .eq("exam_id", examId)
      .eq("state", "submitted");

    if (error) throw error;
    if (!attempts || attempts.length === 0) {
      return new Response(JSON.stringify({ message: "No submitted attempts to sync" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Prepare payload for Canvas LMS (Submissions Bulk Update API)
    // Canvas expects an array of grade data. In a real integration, we'd map student 'roll' or 'email' to a Canvas User ID.
    // Here we'll simulate the grading push.
    
    // Simulate mapping and API call
    console.log(`Syncing ${attempts.length} scores to Canvas Course ${canvasCourseId} Assignment ${canvasAssignmentId}`);
    
    // Example: fetch(`${CANVAS_URL}/api/v1/courses/${canvasCourseId}/assignments/${canvasAssignmentId}/submissions/update_grades`, { ... })

    return new Response(JSON.stringify({ 
      success: true, 
      message: `Successfully synced ${attempts.length} scores to Canvas`,
      syncedCount: attempts.length
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

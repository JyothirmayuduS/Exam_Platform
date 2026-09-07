import { getSupabase } from "../supabase";
import type { DBQuestion } from "./types";

export type ItemStats = {
  question_id: string;
  exam_id: string;
  difficulty: string;
  attempt_count: number;
  avg_score: number | null;
  stddev_score: number | null;
  above_avg: number;
  below_avg: number;
};

export async function getItemAnalysis(examId: string): Promise<ItemStats[]> {
  const db = getSupabase();
  if (!db) return [];
  const { data, error } = await db
    .from("item_analysis")
    .select("*")
    .eq("exam_id", examId);
  if (error) {
    console.error("getItemAnalysis error:", error);
    return [];
  }
  return data as ItemStats[];
}

export async function refreshItemAnalysis(): Promise<boolean> {
  const db = getSupabase();
  if (!db) return false;
  const { error } = await db.rpc("refresh_item_analysis");
  if (error) {
    console.error("refreshItemAnalysis error:", error);
    return false;
  }
  return true;
}

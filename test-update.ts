import { createClient } from '@supabase/supabase-js';
import { loadEnv } from 'vite';

const env = loadEnv('', process.cwd(), '');
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);

async function run() {
  const { data: attempts, error: readError } = await supabase.from('attempts').select('id, score, exam_id').limit(2);
  console.log("Read attempts:", attempts, readError);

  if (attempts && attempts.length > 0) {
    const { data: updateData, error: updateError } = await supabase.from('attempts').update({ score: 10 }).eq('id', attempts[0].id).select();
    console.log("Update attempt:", updateData, updateError);
  }
}
run();

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY);

async function run() {
  // Try to read attempts
  const { data: attempts, error: readError } = await supabase.from('attempts').select('id, score').limit(1);
  console.log("Read attempts:", attempts, readError);

  if (attempts && attempts.length > 0) {
    const { data: updateData, error: updateError } = await supabase.from('attempts').update({ score: 10 }).eq('id', attempts[0].id).select();
    console.log("Update attempt:", updateData, updateError);
  }
}
run();

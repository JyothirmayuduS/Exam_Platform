export async function scoreEssay(text: string, rubric: Record<string,string>) {
  // Uses Hugging Face Inference API (user selected) — not OpenAI
  // Endpoint: https://api-inference.huggingface.co/models/HuggingFaceH4/zephyr-7b-beta
  const prompt = `Score essay against rubric: ${JSON.stringify(rubric)}\nEssay: ${text.slice(0,3000)}`;
  return { score: null, feedback: "HF endpoint not wired — stub implemented", rubric };
}

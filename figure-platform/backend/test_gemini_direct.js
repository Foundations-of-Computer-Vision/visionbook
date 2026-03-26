require('dotenv').config();
const key = process.env.GOOGLE_API_KEY;
console.log('GOOGLE_API_KEY present:', !!key, key ? '(len=' + key.length + ')' : '(MISSING)');

(async () => {
  try {
    const { GoogleGenAI } = await import('@google/genai');
    const client = new GoogleGenAI({ apiKey: key });
    console.log('Client created. Calling gemini-2.5-flash...');
    const result = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'Say hello in 3 words.'
    });
    console.log('SUCCESS:', result.text);
  } catch(e) {
    console.error('ERROR:', e.message);
    console.error('Error name:', e.constructor?.name);
    if (e.cause) {
      console.error('Cause type:', e.cause?.constructor?.name);
      console.error('Cause code:', e.cause?.code);
      console.error('Cause message:', e.cause?.message);
      if (e.cause?.cause) {
        console.error('Cause.cause:', e.cause.cause?.message, e.cause.cause?.code);
      }
    }
    console.error('HTTP status:', e.status || e.statusCode || 'n/a');
    console.error('Full stack:');
    console.error(e.stack);
  }
})();

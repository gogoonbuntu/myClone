// Quick API test script
// Usage: GROQ_API_KEY=xxx GOOGLE_API_KEY=xxx node test-api.js
const https = require('https');

const API_KEY = process.env.GROQ_API_KEY || '';

const data = JSON.stringify({
  model: 'llama-3.3-70b-versatile',
  messages: [{ role: 'user', content: 'Hello, say hi in 5 words' }],
  max_tokens: 30,
  stream: false,
});

const req = https.request({
  hostname: 'api.groq.com',
  path: '/openai/v1/chat/completions',
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 15000,
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    try {
      const j = JSON.parse(body);
      if (j.choices) console.log('Groq OK:', j.choices[0].message.content);
      else console.log('Groq Response:', body.slice(0, 500));
    } catch { console.log('Raw:', body.slice(0, 500)); }
  });
});

req.on('error', e => console.log('Groq Error:', e.message));
req.on('timeout', () => { console.log('Groq TIMEOUT'); req.destroy(); });
req.write(data);
req.end();

// Also test Google
const GOOGLE_KEY = process.env.GOOGLE_API_KEY || '';
const gdata = JSON.stringify({
  contents: [{ parts: [{ text: 'Say hello in 3 words' }] }],
});

const greq = https.request({
  hostname: 'generativelanguage.googleapis.com',
  path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${GOOGLE_KEY}`,
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  timeout: 15000,
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log('\nGoogle Status:', res.statusCode);
    try {
      const j = JSON.parse(body);
      if (j.candidates) console.log('Gemini OK:', j.candidates[0].content.parts[0].text);
      else console.log('Gemini Response:', body.slice(0, 500));
    } catch { console.log('Gemini Raw:', body.slice(0, 500)); }
  });
});

greq.on('error', e => console.log('Gemini Error:', e.message));
greq.on('timeout', () => { console.log('Gemini TIMEOUT'); greq.destroy(); });
greq.write(gdata);
greq.end();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/init' && request.method === 'POST') {
      const { ok, id, code } = getId(request);
      if (!ok) return new Response('Invalid ID', { status: code });
      return await handleInit(id, env);
    }

    if (request.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const asset = await env.ASSETS.fetch(new Request(url.origin + '/index.html'));
        const html = await asset.text();
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
      }
      if (url.pathname === '/sw.js') {
        const asset = await env.ASSETS.fetch(new Request(url.origin + '/sw.js'));
        const text = await asset.text();
        return new Response(text, { headers: { 'Content-Type': 'application/javascript; charset=UTF-8' } });
      }
      if (url.pathname === '/manifest.webmanifest') {
        const asset = await env.ASSETS.fetch(new Request(url.origin + '/manifest.webmanifest'));
        const text = await asset.text();
        return new Response(text, { headers: { 'Content-Type': 'application/manifest+json; charset=UTF-8' } });
      }
      if (url.pathname === '/icon.svg') {
        const asset = await env.ASSETS.fetch(new Request(url.origin + '/icon.svg'));
        const text = await asset.text();
        return new Response(text, { headers: { 'Content-Type': 'image/svg+xml; charset=UTF-8' } });
      }
    }

    const { ok, id, code } = getId(request);
    if (!ok) return new Response(code === 401 ? 'Unauthorized' : 'Invalid ID', { status: code });

    try {
      if (url.pathname === '/api/chat' && request.method === 'POST') {
        const { messages = [] } = await request.json();
        return await handleChat(id, env, messages);
      }
      if (url.pathname === '/api/learn' && request.method === 'GET') {
        return await handleGetQuestion(id, env);
      }
      if (url.pathname === '/api/learn' && request.method === 'POST') {
        const body = await request.json();
        return await handleSubmitAnswer(id, env, body.selected);
      }
      return new Response('Not found', { status: 404 });
    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  }
};

const defaultPersona = 'You are the digital twin of a real person who is ruthlessly asexual and devoid of gender or racial attributes.';

function json(obj) {
  return new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } });
}

function isValidUUID(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
}

function getId(request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return { ok: false, code: 401 };
  const id = auth.slice(7);
  if (!isValidUUID(id)) return { ok: false, code: 400 };
  return { ok: true, id };
}

async function getUser(env, id) {
  const text = await env.KV.get(id);
  return text ? JSON.parse(text) : null;
}

async function saveUser(env, id, data) {
  data.lastUsed = new Date().toISOString();
  await env.KV.put(id, JSON.stringify(data));
}

async function handleInit(id, env) {
  let data = await getUser(env, id);
  if (!data) {
    const [out] = await groqChat(env, [{ role: 'user', content: 'Give me a random name for a person that is not associated with a particular gender. Do not respond with anything other than the forename and surname.' }]);
    const name = out.trim().split(/[\n,]/)[0];
    data = { name, persona: defaultPersona, guidance: '', coverage: {}, stats: { asked: 0, correct: 0, history: [] }, pending: null };
  }
  await saveUser(env, id, data);
  return json({ name: data.name, id });
}

async function handleChat(id, env, messages) {
  const data = await getUser(env, id);
  if (!data) return new Response('Not found', { status: 404 });
  const systemMsg = { role: 'system', content: `Persona:\n${data.persona}\nGuidance:\n${data.guidance}\nAnswer strictly as this persona while avoiding any mention of gender, sexuality or race. Be concise and give a clear, direct reply in one short sentence.` };
  const [out] = await groqChat(env, [systemMsg, ...messages]);
  await saveUser(env, id, data);
  return json({ choices: [{ message: { role: 'assistant', content: out.trim() } }] });
}

async function handleGetQuestion(id, env) {
  const data = await getUser(env, id);
  if (!data) return new Response('Not found', { status: 404 });
  const qa = await generateQuestion(env, data);
  data.pending = qa;
  await saveUser(env, id, data);
  const confidence = computeConfidence(data.stats.history);
  return json({ ...qa, confidence });
}

async function handleSubmitAnswer(id, env, selected) {
  const data = await getUser(env, id);
  if (!data) return new Response('Not found', { status: 404 });
  const pending = data.pending;
  if (!pending) return new Response('No question', { status: 400 });
  const answer = pending.answers[selected];
  const prompt = `Existing persona:\n${data.persona}\nGuidance:\n${data.guidance}\nQuestion:${pending.question}\nCategory:${pending.category}\nAnswers:${pending.answers.join(' | ')}\nUser selected:${answer}. Revise the persona incrementally so it leans toward this option while avoiding assumptions about name, gender, sexuality, or race. Ensure the persona remains ruthlessly asexual, concise and non-redundant. Reply with the updated persona text only.`;
  const [out] = await groqChat(env, [{ role: 'user', content: prompt }]);
  const newPersona = optimizePersonaText(out.trim());
  data.persona = newPersona;
  data.coverage[pending.category] = (data.coverage[pending.category] || 0) + 1;
  const correct = selected === pending.personaIndex;
  data.stats.asked++;
  if (correct) data.stats.correct++;
  data.stats.history.push(correct);
  if (data.stats.history.length > 10) data.stats.history.splice(0, data.stats.history.length - 10);
  const qa = await generateQuestion(env, data);
  data.pending = qa;
  await saveUser(env, id, data);
  const confidence = computeConfidence(data.stats.history);
  return json({ ...qa, confidence });
}

function optimizePersonaText(text) {
  const sentences = text.split(/[\.\n]+/).map(s => s.trim()).filter(Boolean);
  const unique = [...new Set(sentences)];
  return unique.map(s => s.replace(/\s+/g, ' ')).join('. ') + '.';
}

async function groqChat(env, messages) {
  const key = await env.KV.get('groq-api-key');
  if (!key) throw new Error('Missing API key');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: 'llama-3.1-8b-instant', temperature: 0.7, messages })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  const j = JSON.parse(text);
  return (j.choices || []).map(c => c.message?.content).filter(Boolean);
}

const categories = [
  { name: 'Likes & Dislikes', desc: 'tastes in activities or food' },
  { name: 'Politics & Society', desc: 'political and social outlook' },
  { name: 'Geography & Climate', desc: 'preferred places and weather' },
  { name: 'Energy & Routine', desc: 'daily energy and lifestyle' },
  { name: 'Aspirations & Goals', desc: 'career or life ambitions' },
  { name: 'Psychological Traits', desc: 'thinking patterns and behaviour' },
  { name: 'Culture & Arts', desc: 'music, media and art interests' },
  { name: 'Relationships & Community', desc: 'friendships and social ties' },
  { name: 'Work & Productivity', desc: 'discipline and work style' },
  { name: 'Decision Making & Values', desc: 'how choices and priorities form' },
  { name: 'Emotions & Coping', desc: 'responses to stress or loss' },
  { name: 'Technology & Innovation', desc: 'attitude toward new tech' },
  { name: 'Spare Time & Hobbies', desc: 'weekend and leisure pursuits' },
  { name: 'Financial Outlook', desc: 'saving, spending or investing' },
  { name: 'Travel & Adventure', desc: 'motivation for exploring new places' }
];

function leastCovered(coverage) {
  let min = Infinity, opts = [];
  for (const c of categories) {
    const v = coverage[c.name] || 0;
    if (v < min) { min = v; opts = [c]; }
    else if (v === min) { opts.push(c); }
  }
  return opts[Math.floor(Math.random() * opts.length)];
}

function computeConfidence(history) {
  if (history.length < 10) return 'low';
  const wrong = history.filter(v => !v).length;
  if (wrong === 0) return 'high';
  if (wrong > 3) return 'low';
  return 'medium';
}

async function generateQuestion(env, data) {
  const cat = leastCovered(data.coverage);
  const prompt = `Persona:\n${data.persona}\nGuidance:\n${data.guidance}\n\nGenerate one concise multiple-choice question (<=15 words) about this persona's ${cat.name} (${cat.desc}). Provide two to four brief answers (<=6 words) that are mutually exclusive and collectively exhaustive. Do not include 'not applicable' or similar options and avoid any reference to gender, sexuality or race. Only repeat a topic to clarify ambiguity. Return JSON {question:string, answers:string[], personaIndex:number}.`;
  const [out] = await groqChat(env, [{ role: 'user', content: prompt }]);
  const match = out.match(/\{[\s\S]*\}/);
  const cleaned = match[0].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const qa = JSON.parse(cleaned);
  return { question: qa.question, answers: qa.answers, personaIndex: qa.personaIndex, category: cat.name };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const asset = await env.ASSETS.fetch(new Request(url.origin + '/index.html'));
        const html = await asset.text();
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=UTF-8' }
        });
      }
      if (url.pathname === '/sw.js') {
        const asset = await env.ASSETS.fetch(new Request(url.origin + '/sw.js'));
        const text = await asset.text();
        return new Response(text, {
          headers: { 'Content-Type': 'application/javascript; charset=UTF-8' }
        });
      }
      if (url.pathname === '/manifest.webmanifest') {
        const asset = await env.ASSETS.fetch(new Request(url.origin + '/manifest.webmanifest'));
        const text = await asset.text();
        return new Response(text, {
          headers: { 'Content-Type': 'application/manifest+json; charset=UTF-8' }
        });
      }
      if (url.pathname === '/icon.svg') {
        const asset = await env.ASSETS.fetch(new Request(url.origin + '/icon.svg'));
        const text = await asset.text();
        return new Response(text, {
          headers: { 'Content-Type': 'image/svg+xml; charset=UTF-8' }
        });
      }
    }
    const auth = request.headers.get('Authorization') || '';
    const id = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if(!id) return new Response('Unauthorized', {status:401});

    try {
      if(url.pathname === '/api/init' && request.method === 'POST') {
        return await handleInit(id, env);
      }
      if(url.pathname === '/api/profile' && request.method === 'GET') {
        return await handleProfile(id, env);
      }
      if(url.pathname === '/api/guidance' && request.method === 'POST') {
        const {guidance=''} = await request.json();
        await env.KV.put(`${id}-guidance`, guidance);
        return new Response('OK');
      }
      if(url.pathname === '/api/name' && request.method === 'POST') {
        const {name=''} = await request.json();
        await env.KV.put(`${id}-name`, name);
        return new Response('OK');
      }
      if(url.pathname === '/api/persona' && request.method === 'POST') {
        const {persona, guidance} = await request.json();
        if(persona) await env.KV.put(`${id}-persona`, optimizePersonaText(persona));
        if(guidance !== undefined) await env.KV.put(`${id}-guidance`, guidance);
        return new Response('OK');
      }
      if(url.pathname === '/api/chat' && request.method === 'POST') {
        const {messages=[]} = await request.json();
        const persona = (await env.KV.get(`${id}-persona`)) || defaultPersona;
        const guidance = (await env.KV.get(`${id}-guidance`)) || '';
        const systemMsg = {role:'system', content:`Persona:\n${persona}\nGuidance:\n${guidance}\nAnswer strictly as this persona while avoiding any mention of gender, sexuality or race. Be concise and give a clear, direct reply in one short sentence.`};
        const [out] = await groqChat(env, [systemMsg, ...messages]);
        return json({choices:[{message:{role:'assistant',content:out.trim()}}]});
      }
      if(url.pathname === '/api/learn' && request.method === 'GET') {
        return await handleGetQuestion(id, env);
      }
      if(url.pathname === '/api/learn' && request.method === 'POST') {
        const body = await request.json();
        return await handleSubmitAnswer(id, env, body.selected);
      }
      return new Response('Not found', {status:404});
    } catch(err) {
      return new Response(err.toString(), {status:500});
    }
  }
}

const defaultPersona='You are the digital twin of a real person who is ruthlessly asexual and devoid of gender or racial attributes.';

function json(obj){return new Response(JSON.stringify(obj),{headers:{'Content-Type':'application/json'}});}

async function handleInit(id, env){
  let name = await env.KV.get(`${id}-name`);
  if(!name){
    const [out] = await groqChat(env,[{role:'user',content:'Generate a short, non-gendered human name.'}]);
    name = out.trim().split(/[\n,]/)[0];
    await env.KV.put(`${id}-name`, name);
  }
  if(!await env.KV.get(`${id}-persona`)){
    await env.KV.put(`${id}-persona`, defaultPersona);
  }
  return json({name});
}

async function handleProfile(id, env){
  const persona = (await env.KV.get(`${id}-persona`)) || defaultPersona;
  const guidance = (await env.KV.get(`${id}-guidance`)) || '';
  const name = (await env.KV.get(`${id}-name`)) || '';
  return json({persona,guidance,name});
}

function optimizePersonaText(text){
  const sentences=text.split(/[\.\n]+/).map(s=>s.trim()).filter(Boolean);
  const unique=[...new Set(sentences)];
  return unique.map(s=>s.replace(/\s+/g,' ')).join('. ')+'.';
}

async function groqChat(env, messages){
  const key = await env.KV.get('groq-api-key');
  if(!key) throw new Error('Missing API key');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions',{
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
    body:JSON.stringify({model:'llama-3.1-8b-instant',temperature:0.7,messages})
  });
  const text = await r.text();
  if(!r.ok) throw new Error(text);
  const j = JSON.parse(text);
  return (j.choices||[]).map(c=>c.message?.content).filter(Boolean);
}

const categories=[
  {name:'Likes & Dislikes',desc:'tastes in activities or food'},
  {name:'Politics & Society',desc:'political and social outlook'},
  {name:'Geography & Climate',desc:'preferred places and weather'},
  {name:'Energy & Routine',desc:'daily energy and lifestyle'},
  {name:'Aspirations & Goals',desc:'career or life ambitions'},
  {name:'Psychological Traits',desc:'thinking patterns and behaviour'},
  {name:'Culture & Arts',desc:'music, media and art interests'},
  {name:'Relationships & Community',desc:'friendships and social ties'},
  {name:'Work & Productivity',desc:'discipline and work style'},
  {name:'Decision Making & Values',desc:'how choices and priorities form'},
  {name:'Emotions & Coping',desc:'responses to stress or loss'},
  {name:'Technology & Innovation',desc:'attitude toward new tech'},
  {name:'Spare Time & Hobbies',desc:'weekend and leisure pursuits'},
  {name:'Financial Outlook',desc:'saving, spending or investing'},
  {name:'Travel & Adventure',desc:'motivation for exploring new places'}
];

function leastCovered(coverage){
  let min=Infinity, opts=[];
  for(const c of categories){
    const v=coverage[c.name]||0;
    if(v<min){min=v;opts=[c];}
    else if(v===min){opts.push(c);}
  }
  return opts[Math.floor(Math.random()*opts.length)];
}

function computeConfidence(stats){
  if(stats.length<10) return 'low';
  const wrong = stats.filter(v=>!v).length;
  if(wrong===0) return 'high';
  if(wrong>3) return 'low';
  return 'medium';
}

async function generateQuestion(id, env, persona, guidance, coverage){
  const cat = leastCovered(coverage);
  const prompt=`Persona:\n${persona}\nGuidance:\n${guidance}\n\nGenerate one concise multiple-choice question (<=15 words) about this persona's ${cat.name} (${cat.desc}). Provide two to four brief answers (<=6 words) that are mutually exclusive and collectively exhaustive. Do not include 'not applicable' or similar options and avoid any reference to gender, sexuality or race. Only repeat a topic to clarify ambiguity. Return JSON {question:string, answers:string[], personaIndex:number}.`;
  const [out]=await groqChat(env,[{role:'user',content:prompt}]);
  const match=out.match(/\{[\s\S]*\}/);
  const cleaned=match[0].replace(/\/\/.*$/gm,'').replace(/\/\*[\s\S]*?\*\//g,'');
  const qa=JSON.parse(cleaned);
  const pending={question:qa.question,answers:qa.answers,personaIndex:qa.personaIndex,category:cat.name};
  await env.KV.put(`${id}-pending`, JSON.stringify(pending));
  return pending;
}

async function handleGetQuestion(id, env){
  const persona=(await env.KV.get(`${id}-persona`))||defaultPersona;
  const guidance=(await env.KV.get(`${id}-guidance`))||'';
  const coverage=JSON.parse(await env.KV.get(`${id}-coverage`)||'{}');
  const stats=JSON.parse(await env.KV.get(`${id}-stats`)||'[]');
  const qa=await generateQuestion(id, env, persona, guidance, coverage);
  const confidence=computeConfidence(stats);
  return json({...qa, confidence, persona});
}

async function handleSubmitAnswer(id, env, selected){
  const persona=(await env.KV.get(`${id}-persona`))||defaultPersona;
  const guidance=(await env.KV.get(`${id}-guidance`))||'';
  const pending=JSON.parse(await env.KV.get(`${id}-pending`)||'null');
  if(!pending) return new Response('No question', {status:400});
  const coverage=JSON.parse(await env.KV.get(`${id}-coverage`)||'{}');
  const stats=JSON.parse(await env.KV.get(`${id}-stats`)||'[]');
  const answer=pending.answers[selected];
  const prompt=`Existing persona:\n${persona}\nGuidance:\n${guidance}\nQuestion:${pending.question}\nCategory:${pending.category}\nAnswers:${pending.answers.join(' | ')}\nUser selected:${answer}. Revise the persona incrementally so it leans toward this option while avoiding assumptions about name, gender, sexuality, or race. Ensure the persona remains ruthlessly asexual, concise and non-redundant. Reply with the updated persona text only.`;
  const [out]=await groqChat(env,[{role:'user',content:prompt}]);
  const newPersona=optimizePersonaText(out.trim());
  await env.KV.put(`${id}-persona`, newPersona);
  coverage[pending.category]=(coverage[pending.category]||0)+1;
  await env.KV.put(`${id}-coverage`, JSON.stringify(coverage));
  const correct = selected===pending.personaIndex;
  stats.push(correct); if(stats.length>10) stats.splice(0,stats.length-10);
  await env.KV.put(`${id}-stats`, JSON.stringify(stats));
  const qa=await generateQuestion(id, env, newPersona, guidance, coverage);
  const confidence=computeConfidence(stats);
  return json({...qa, confidence, persona:newPersona});
}


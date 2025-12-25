const BASIC_AUTH_HEADER = 'Basic ';

function decodeBase64(value) {
  if (typeof atob === 'function') return atob(value);
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64').toString('utf8');
  throw new Error('No base64 decoder available');
}

export async function handleAdmin(request, env) {
  const username = env.ADMIN_USERNAME;
  const password = env.ADMIN_PASSWORD;
  if (!username || !password) {
    return new Response('Admin credentials not configured', { status: 500 });
  }

  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith(BASIC_AUTH_HEADER)) {
    return new Response('Missing Authorization', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="admin", charset="UTF-8"' }
    });
  }

  const decoded = decodeBase64(auth.slice(BASIC_AUTH_HEADER.length));
  const [user, pass] = decoded.split(':');
  if (user !== username || pass !== password) {
    return new Response('Forbidden', { status: 403 });
  }

  return new Response('Admin OK', { status: 200 });
}

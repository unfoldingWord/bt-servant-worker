export interface Env {
  ENVIRONMENT: string;
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json({ status: 'healthy' });
    }

    if (url.pathname === '/api/v1/chat' && request.method === 'POST') {
      return new Response('BT Servant is alive and well.', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};

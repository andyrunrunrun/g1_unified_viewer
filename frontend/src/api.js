export async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export async function postJson(url, payload) {
  const options = { method: 'POST' };
  if (payload !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export function formatJson(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

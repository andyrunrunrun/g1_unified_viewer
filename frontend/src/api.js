export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', signal: options.signal });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export async function postJson(url, payload, options = {}) {
  const fetchOptions = { method: 'POST', signal: options.signal };
  if (payload !== undefined) {
    fetchOptions.headers = { 'Content-Type': 'application/json' };
    fetchOptions.body = JSON.stringify(payload);
  }
  const response = await fetch(url, fetchOptions);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json();
}

export function formatJson(value) {
  return JSON.stringify(value ?? {}, null, 2);
}

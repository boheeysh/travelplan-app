// 백엔드 API 호출 모음 (브라우저에서는 키를 다루지 않음)
export async function getJSON(url) {
  const res = await fetch(url);
  return res.json();
}

export async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

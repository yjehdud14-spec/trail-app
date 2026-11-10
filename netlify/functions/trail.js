// 산림청_산 정보 조회_GW 프록시 (Netlify Functions)
// - 인증키는 Netlify 환경 변수 DATA_GO_KR_KEY(Decoding 키)에서만 읽습니다.
// - 키는 encodeURIComponent로 딱 한 번만 인코딩합니다(URLSearchParams를 쓰지 않음 → 이중 인코딩 방지).
// - 공공데이터포털이 돌려준 resultCode / resultMsg를 가공 없이 그대로 페이지에 전달합니다.

// 요청 주소: data.go.kr/data/15158978 활용명세(Swagger)의 Request URL로 확인하세요.
// 오퍼레이션 경로가 따로 있으면 환경 변수 TRAIL_API_URL에 전체 주소를 넣으면 그 값이 우선합니다.
const DEFAULT_API_URL = 'https://apis.data.go.kr/1400000/trailInfoService';

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

// <tag>값</tag> 하나 꺼내기
const tag = (xml, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1]) : null;
};
const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();

function parseXml(xml) {
  // 게이트웨이 오류 형식: <OpenAPI_ServiceResponse><cmmMsgHeader>…
  if (xml.includes('<cmmMsgHeader>')) {
    return {
      resultCode: tag(xml, 'returnReasonCode'),
      resultMsg: [tag(xml, 'errMsg'), tag(xml, 'returnAuthMsg')].filter(Boolean).join(' / '),
      items: []
    };
  }
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const o = {};
    for (const f of m[1].matchAll(/<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g)) o[f[1]] = decode(f[2]);
    return o;
  });
  return {
    resultCode: tag(xml, 'resultCode'),
    resultMsg: tag(xml, 'resultMsg'),
    totalCount: tag(xml, 'totalCount'),
    items
  };
}

function parseJson(text) {
  const j = JSON.parse(text);
  const header = (j.response && j.response.header) || j.header || {};
  const body = (j.response && j.response.body) || j.body || {};
  let items = body.items && body.items.item !== undefined ? body.items.item : body.items || [];
  if (!Array.isArray(items)) items = items ? [items] : [];
  return { resultCode: header.resultCode ?? null, resultMsg: header.resultMsg ?? null, totalCount: body.totalCount ?? null, items };
}

exports.handler = async (event) => {
  const mountain = ((event.queryStringParameters || {}).mountain || '').trim();
  if (!mountain) return json(400, { ok: false, resultCode: null, resultMsg: 'mountain 파라미터(산 이름)가 필요합니다' });

  const key = process.env.DATA_GO_KR_KEY;
  if (!key) return json(500, { ok: false, resultCode: null, resultMsg: 'Netlify 환경 변수 DATA_GO_KR_KEY가 설정되지 않았습니다' });

  const base = process.env.TRAIL_API_URL || DEFAULT_API_URL;
  const url = `${base}?serviceKey=${encodeURIComponent(key)}`
    + `&pageNo=1&numOfRows=20`
    + `&mntnNm=${encodeURIComponent(mountain)}`;
  const safeUrl = url.replace(/serviceKey=[^&]+/, 'serviceKey=***'); // 화면 표시용(키 가림)

  let res, text;
  try {
    res = await fetch(url, { headers: { Accept: 'application/xml, application/json' } });
    text = await res.text();
  } catch (e) {
    return json(502, { ok: false, resultCode: null, resultMsg: '공공데이터포털에 연결하지 못했습니다: ' + e.message, requestUrl: safeUrl });
  }

  let parsed;
  try {
    const t = text.trim();
    parsed = t.startsWith('{') ? parseJson(t) : t.startsWith('<') ? parseXml(t) : null;
  } catch (e) {
    parsed = null;
  }

  if (!parsed) {
    // XML/JSON이 아닌 응답(예: "Unauthorized", HTML 오류 페이지)은 원문 일부를 그대로 보여줌
    return json(502, { ok: false, httpStatus: res.status, resultCode: null, resultMsg: '해석할 수 없는 응답', raw: text.slice(0, 500), requestUrl: safeUrl });
  }

  const ok = res.ok && ['00', '0', '0000'].includes(String(parsed.resultCode));
  return json(200, {
    ok,
    httpStatus: res.status,
    resultCode: parsed.resultCode,
    resultMsg: parsed.resultMsg,
    totalCount: parsed.totalCount ?? null,
    items: parsed.items,
    requestUrl: safeUrl,
    raw: ok ? undefined : text.slice(0, 500)
  });
};

/**
 * 아랑유치원 통신문·식단 자동 정리 (Gmail → Gemini API → 캘린더 + 드라이브 문서 + HA 피드)
 * - 중복 행사·기한 캘린더 교차 병합(Gemini) 및 날짜별 준비물·복장 충돌 정규화 포함
 */

const KINDERGARTEN = '아랑유치원';
const CAL_NAME     = '다올';   // 일정을 넣을 캘린더 이름 (없으면 자동 생성)
const MY_CLASS     = '다정한반';
const MY_AGE_GROUP = '6세반';   // 해가 바뀌면 함께 수정 (예: 2027년 7세반)
const SEARCH_QUERY = 'from:me to:me newer_than:3d -label:자동요약-처리됨';
const LABEL_DONE   = '자동요약-처리됨';
const LABEL_SKIP   = '자동요약-관련없음';
const DOC_NAME     = '통신문 요약';
const MAX_THREADS  = 20;
const MAX_BYTES    = 14 * 1024 * 1024;
const DONE_KEY     = 'DONE_MSG_IDS';
const DONE_KEEP_MS = 30 * 86400000;
const FEED_DAYS    = 10;       // HA로 보낼 범위: 오늘-9일 뒤
const ATTACH_TYPES = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/i;

function runOnce() {
  const props  = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const model  = props.getProperty('GEMINI_MODEL') || 'gemini-4-neon';
  if (!apiKey) throw new Error('스크립트 속성 GEMINI_API_KEY가 없습니다.');

  const done = getOrCreateLabel_(LABEL_DONE);
  const skip = getOrCreateLabel_(LABEL_SKIP);
  const doneIds = loadDoneIds_(props);
  const touchedDates = new Set();

  GmailApp.search(SEARCH_QUERY, 0, MAX_THREADS).forEach(thread => {
    try {
      let related = false;
      thread.getMessages().forEach(msg => {
        const id = msg.getId();
        if (doneIds[id]) { if (doneIds[id].rel) related = true; return; }
        const r = analyzeMessage_(msg, apiKey, model);
        const rel = !!(r && r.is_related);
        if (rel) {
          related = true;
          const res = addCalendar_(r);
          res.dates.forEach(d => touchedDates.add(d));
          prependToDoc_(r, res.added, msg);
        }
        doneIds[id] = { t: Date.now(), rel: rel };
        saveDoneIds_(props, doneIds);
      });
      thread.addLabel(done);
      if (!related) thread.addLabel(skip);
    } catch (e) {
      console.error('실패: ' + thread.getFirstMessageSubject() + ' / ' + e);
    }
  });

  // 새로 일정이 추가된 날짜들에 대해 캘린더 내 중복 행사·기한·복장 충돌 교차 병합
  if (touchedDates.size > 0) {
    try {
      consolidateCalendarDates_(Array.from(touchedDates), apiKey, model);
    } catch (e) {
      console.error('캘린더 중복 병합 실패: ' + e);
    }
  }

  try { pushKinderFeed(); } catch (e) { console.error('HA 전송 실패: ' + e); }
}

/**
 * 1회 수동 실행용: 이미 '다올' 캘린더에 들어가 있는 오늘-30일 뒤 일정의 중복을 즉시 정리하고 HA로 전송
 */
function consolidateCalendarNow() {
  const props  = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const model  = props.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  if (!apiKey) throw new Error('스크립트 속성 GEMINI_API_KEY가 없습니다.');

  const tz = 'Asia/Seoul';
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(from.getTime() + 30 * 86400000);
  const dates = new Set();

  getTargetCalendar_().getEvents(from, to).forEach(ev => {
    if (!/^\[(통신문|식단)\]/.test(ev.getTitle())) return;
    const start = ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime();
    dates.add(Utilities.formatDate(start, tz, 'yyyy-MM-dd'));
  });

  if (dates.size > 0) {
    consolidateCalendarDates_(Array.from(dates).sort(), apiKey, model);
  }
  pushKinderFeed();
}

/**
 * 지정된 날짜들의 '다올' 캘린더 일정을 검사해 [식단] 중복 제거 및 [통신문] 교차 병합 수행
 */
function consolidateCalendarDates_(dateStrings, apiKey, model) {
  const cal = getTargetCalendar_();
  const tz = 'Asia/Seoul';
  const multiNoticePayload = [];
  const eventsByDateMap = {};

  dateStrings.sort().forEach(dateStr => {
    const d = parseDate_(dateStr);
    if (!d) return;
    const nextD = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const dayEvents = cal.getEvents(d, nextD);

    const noticeEvs = [];
    const menuEvs = [];

    dayEvents.forEach(ev => {
      const start = ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime();
      if (Utilities.formatDate(start, tz, 'yyyy-MM-dd') !== dateStr) return;
      const title = ev.getTitle();
      if (/^\[식단\]/.test(title)) menuEvs.push(ev);
      else if (/^\[통신문\]/.test(title)) noticeEvs.push(ev);
    });

    // 1) 같은 날 [식단] 중복이면 가장 긴(상세한) 1건만 남기고 삭제
    if (menuEvs.length > 1) {
      menuEvs.sort((a, b) => b.getTitle().length - a.getTitle().length);
      for (let i = 1; i < menuEvs.length; i++) menuEvs[i].deleteEvent();
    }

    // 2) 같은 날 [통신문]이 2건 이상이면 Gemini 교차 병합 대상에 추가
    if (noticeEvs.length >= 2) {
      eventsByDateMap[dateStr] = noticeEvs;
      multiNoticePayload.push({
        date: dateStr,
        items: noticeEvs.map(ev => {
          const title = ev.getTitle();
          const allDay = ev.isAllDayEvent();
          const desc = ev.getDescription() || '';
          const im = /^준비물:\s*(.+)$/m.exec(desc);
          const isDeadline = /^\[통신문\]\s*기한:\s*/.test(title);
          return {
            kind: isDeadline ? 'deadline' : 'event',
            time: allDay ? '' : Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm'),
            end_time: allDay ? '' : Utilities.formatDate(ev.getEndTime(), tz, 'HH:mm'),
            what: title.replace(/^\[통신문\]\s*(기한:\s*)?/, '').trim(),
            items: im ? im[1].trim() : '',
            desc: desc.slice(0, 300)
          };
        })
      });
    }
  });

  if (multiNoticePayload.length === 0) return;

  const prompt = [
    '당신은 ' + KINDERGARTEN + ' ' + MY_AGE_GROUP + ' ' + MY_CLASS + ' 캘린더 일정 중복 병합 엔진입니다.',
    '아래 날짜별 [통신문] 일정 목록은 가정통신문·주간계획안·교육비납부서 등 여러 문서에서 따로 들어와 중복이 섞여 있습니다.',
    '각 날짜별로 아래 규칙에 따라 정리하고 JSON으로만 답하세요.',
    '',
    '[규칙]',
    '1. 같은 날짜의 동일 행사·안내(예: "6세 다정한반 현장학습"과 "강서별빛우주과학관 견학", "교육비 안내"와 "12월 교육비납부서")는 반드시 1건으로 병합하세요.',
    '2. 병합 시 장소·시간·정확한 금액 등 가장 구체적인 표현을 채택하세요.',
    '3. 실제로 서로 다른 행사(예: 숲체험과 우주 골든벨)는 각각 유지하되, 두 문서에 걸쳐 중복된 항목은 합치세요.',
    '4. 각 행사의 items(준비물)에서 중복 단어와 하위 포괄어(예: "동복체육복(겉옷 포함)"이 있으면 "체육복" 제거)를 정리하세요.',
    '5. 같은 날짜의 행사들 사이에 상충하는 등원 복장(예: "원복"과 "체육복/동복체육복")이 공존하면 임의로 하나를 버리지 말고, 해당 날짜 대표 행사 1곳의 note에 "복장 확인 필요(원복 vs 체육복 공존)"를 명시하세요.',
    '6. 타 반(예: 즐거운반) 전용 일정이 섞여 있으면 제거하세요.',
    '7. 병합·수정이 전혀 필요 없는 날짜는 changed를 false로 두세요.',
    '',
    '입력 데이터:',
    JSON.stringify(multiNoticePayload),
    '',
    '응답 JSON 형식:',
    '{',
    '  "dates": [',
    '    {',
    '      "date": "YYYY-MM-DD",',
    '      "changed": true,',
    '      "events": [',
    '        {"kind": "event 또는 deadline", "time": "HH:MM 또는 빈 문자열", "end_time": "HH:MM 또는 빈 문자열", "what": "정리된 제목", "items": "정리된 준비물(없으면 빈 문자열)", "note": "핵심 메모 또는 복장 확인 필요 안내"}',
    '      ]',
    '    }',
    '  ]',
    '}'
  ].join('\n');

  const result = callGeminiJson_(apiKey, model, [{ text: prompt }]);
  const consolidatedDates = (result && Array.isArray(result.dates)) ? result.dates : [];

  consolidatedDates.forEach(entry => {
    if (!entry || !entry.changed || !Array.isArray(entry.events) || entry.events.length === 0) return;
    const oldEvs = eventsByDateMap[entry.date];
    const d = parseDate_(entry.date);
    if (!oldEvs || !d) return;

    // 기존 중복 이벤트 삭제 후 통합된 이벤트로 교체
    oldEvs.forEach(ev => ev.deleteEvent());

    entry.events.forEach(ev => {
      const isDeadline = ev.kind === 'deadline';
      const title = isDeadline ? ('[통신문] 기한: ' + ev.what) : ('[통신문] ' + ev.what);
      const descParts = [];
      if (!isDeadline && ev.items) descParts.push('준비물: ' + ev.items);
      if (ev.note) descParts.push(ev.note);
      descParts.push('(자동 통합 — 원문 대조 권장)');
      const evDesc = descParts.join('\n\n');

      if (isDeadline) {
        cal.createAllDayEvent(title, d, { description: evDesc });
      } else {
        const s = parseTime_(d, ev.time);
        if (s) cal.createEvent(title, s, parseTime_(d, ev.end_time) || new Date(s.getTime() + 3600000), { description: evDesc });
        else cal.createAllDayEvent(title, d, { description: evDesc });
      }
    });
    console.log('캘린더 통합 완료: ' + entry.date + ' (' + oldEvs.length + '건 → ' + entry.events.length + '건)');
  });
}

/**
 * '다올' 캘린더의 [통신문]·[식단] 일정(오늘-FEED_DAYS일)을 Home Assistant 웹훅으로 전송.
 * 같은 날짜 내 여러 행사의 준비물 중복·하위어를 정리하고 복장 충돌 시 안내 문구를 자동 부착.
 */
function pushKinderFeed() {
  const url = PropertiesService.getScriptProperties().getProperty('HA_WEBHOOK_URL');
  if (!url) { console.warn('스크립트 속성 HA_WEBHOOK_URL 없음 — HA 전송 생략'); return; }
  const tz = 'Asia/Seoul';
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(from.getTime() + FEED_DAYS * 86400000);
  const entries = [];
  getTargetCalendar_().getEvents(from, to).forEach(ev => {
    const title = ev.getTitle();
    const allDay = ev.isAllDayEvent();
    const start = allDay ? ev.getAllDayStartDate() : ev.getStartTime();
    const d = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
    const t = allDay ? '' : Utilities.formatDate(start, tz, 'HH:mm');
    let m;
    if ((m = /^\[식단\]\s*(.*)$/.exec(title))) {
      entries.push({ d: d, t: '', k: 'menu', x: m[1], i: '' });
    } else if ((m = /^\[통신문\]\s*기한:\s*(.*)$/.exec(title))) {
      entries.push({ d: d, t: '', k: 'deadline', x: m[1], i: '' });
    } else if ((m = /^\[통신문\]\s*(.*)$/.exec(title))) {
      const im = /^준비물:\s*(.+)$/m.exec(ev.getDescription() || '');
      entries.push({ d: d, t: t, k: 'event', x: m[1], i: im ? im[1].trim() : '' });
    }
  });

  dedupeFeedItems_(entries);

  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ entries: entries }), muteHttpExceptions: true
  });
  console.log('HA 전송: ' + entries.length + '건 → HTTP ' + res.getResponseCode());
  if (res.getResponseCode() >= 300) throw new Error('HA 웹훅 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
}

/**
 * HA 브리핑에서 같은 날짜의 준비물 단어가 반복 읽히지 않도록 날짜 단위로 정규화
 * (예: "체육복, 체육복, 동복체육복(겉옷 포함)" → "동복체육복(겉옷 포함)")
 */
function dedupeFeedItems_(entries) {
  const byDate = {};
  entries.forEach(e => {
    if (e.k !== 'event' || !e.i) return;
    if (!byDate[e.d]) byDate[e.d] = [];
    byDate[e.d].push(e);
  });

  Object.keys(byDate).forEach(d => {
    const evList = byDate[d];
    const allTokens = [];
    evList.forEach(e => {
      e.i.split(/[,/·]/).map(s => s.trim()).filter(Boolean).forEach(tok => allTokens.push(tok));
    });

    // 1) 완전 중복 제거
    let unique = Array.from(new Set(allTokens));

    // 2) 하위 포괄어 제거 (더 구체적인 표현이 있으면 짧은 표현 제거)
    unique = unique.filter(item => {
      const norm = item.replace(/\s+/g, '');
      return !unique.some(other => {
        if (other === item) return false;
        const normOther = other.replace(/\s+/g, '');
        return normOther.includes(norm) && normOther.length > norm.length;
      });
    });

    // 3) 복장 충돌 감지 (원복 vs 체육복)
    const hasUniform = unique.some(s => s.includes('원복'));
    const hasGym = unique.some(s => s.includes('체육복'));
    const hasWarn = unique.some(s => s.includes('복장 확인'));
    if (hasUniform && hasGym && !hasWarn) {
      unique.push('복장 확인 필요(원복·체육복 혼재)');
    }

    // 날짜의 첫 번째 행사에 통합된 준비물을 담고, 같은 날 나머지 행사의 중복 준비물 필드는 비움
    evList[0].i = unique.join(', ');
    for (let idx = 1; idx < evList.length; idx++) {
      evList[idx].i = '';
    }
  });
}

function callGeminiJson_(apiKey, model, parts) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify({
      contents: [{ parts: parts }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 }
    }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  const body = JSON.parse(res.getContentText());
  const cand = body.candidates && body.candidates[0];
  if (!cand || !cand.content || !cand.content.parts) {
    const why = (cand && cand.finishReason) || (body.promptFeedback && body.promptFeedback.blockReason) || 'unknown';
    throw new Error('Gemini 빈 응답: ' + why);
  }
  const text = cand.content.parts.map(p => p.text || '').join('');
  return JSON.parse(text);
}

function loadDoneIds_(props) {
  let m = {};
  try { m = JSON.parse(props.getProperty(DONE_KEY) || '{}'); } catch (e) { m = {}; }
  const cutoff = Date.now() - DONE_KEEP_MS;
  Object.keys(m).forEach(k => { if (!m[k] || m[k].t < cutoff) delete m[k]; });
  return m;
}
function saveDoneIds_(props, m) {
  props.setProperty(DONE_KEY, JSON.stringify(m));
}

function analyzeMessage_(msg, apiKey, model) {
  const parts = [];
  let size = 0;
  msg.getAttachments({ includeInlineImages: true }).forEach(a => {
    const type = a.getContentType();
    if (!ATTACH_TYPES.test(type)) return;
    const bytes = a.getBytes();
    if (size + bytes.length > MAX_BYTES) { console.warn('용량 초과로 제외: ' + a.getName()); return; }
    size += bytes.length;
    parts.push({ inline_data: { mime_type: type.toLowerCase(), data: Utilities.base64Encode(bytes) } });
  });
  const bodyText = (msg.getPlainBody() || '').trim().slice(0, 8000);
  if (!parts.length && bodyText.length < 20) return null;

  const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  const prompt = [
    '아래 메일 본문과 첨부(PDF·사진)를 읽고 JSON으로만 답하세요. 오늘은 ' + today + '입니다.',
    '연도 없는 날짜는 오늘 이후 가장 가까운 날짜로 해석하세요.',
    '자녀는 ' + MY_AGE_GROUP + ' ' + MY_CLASS + '입니다. events에는 전체 대상 행사와 ' + MY_CLASS + ' 또는 ' + MY_AGE_GROUP + ' 전체가 대상인 행사만 넣고,',
    '다른 반·다른 연령만 대상인 행사는 빼세요. 대상이 불분명하면 넣으세요.',
    '신입생 모집·입학 접수·재원생 동생 대상 안내 등 재원 가정과 무관한 일정과 기한은 events·deadlines에서 빼세요.',
    '메일 제목: ' + msg.getSubject(),
    '메일 본문:\n' + (bodyText || '(없음)'),
    '',
    '{',
    ' "is_related": ' + KINDERGARTEN + '(또는 유치원 가정통신문·식단표·행사 안내)과 관련 있으면 true, 아니면 false,',
    ' "title": "문서 제목 또는 한 줄 설명",',
    ' "summary": "보호자가 알아야 할 핵심 3-5줄",',
    ' "events": [{"date":"YYYY-MM-DD","time":"HH:MM 또는 빈 문자열","end_time":"HH:MM 또는 빈 문자열","what":"행사 내용","items":"이 행사 준비물, 없으면 빈 문자열"}],',
    ' "deadlines": [{"date":"YYYY-MM-DD","what":"제출·회신·납부 기한 내용"}],',
    ' "items": ["준비물"],',
    ' "menus": [{"date":"YYYY-MM-DD","menu":"그날 식단(점심·간식)"}],',
    ' "uncertain": "읽기 어렵거나 날짜 해석이 불확실한 부분, 없으면 빈 문자열"',
    '}'
  ].join('\n');
  parts.push({ text: prompt });

  return callGeminiJson_(apiKey, model, parts);
}

function getTargetCalendar_() {
  const list = CalendarApp.getCalendarsByName(CAL_NAME);
  if (list.length) return list[0];
  return CalendarApp.createCalendar(CAL_NAME, { timeZone: 'Asia/Seoul' });
}

function moveExistingToDaol() {
  const src = CalendarApp.getDefaultCalendar();
  const dst = getTargetCalendar_();
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to   = new Date(now.getFullYear(), now.getMonth() + 4, 1);
  let moved = 0;
  src.getEvents(from, to).forEach(ev => {
    const t = ev.getTitle();
    if (!/^\[(통신문|식단)\]/.test(t)) return;
    const opt = { description: ev.getDescription() };
    if (ev.isAllDayEvent()) {
      const s = ev.getAllDayStartDate(), e = ev.getAllDayEndDate();
      const days = Math.round((e - s) / 86400000);
      if (days > 1) dst.createAllDayEvent(t, s, e, opt); else dst.createAllDayEvent(t, s, opt);
    } else {
      dst.createEvent(t, ev.getStartTime(), ev.getEndTime(), opt);
    }
    ev.deleteEvent();
    moved++;
  });
  console.log('옮긴 일정: ' + moved + '개 → ' + CAL_NAME);
}

function addCalendar_(r) {
  const cal = getTargetCalendar_();
  const desc = (r.title || '') + '\n' + (r.summary || '') + '\n\n(자동 등록 — 날짜는 원문과 대조하세요)';
  const out = [];
  const dates = new Set();
  (r.events || []).forEach(ev => {
    const d = parseDate_(ev.date); if (!d) return;
    dates.add(ev.date);
    const title = '[통신문] ' + ev.what;
    const evDesc = (ev.items ? '준비물: ' + ev.items + '\n\n' : '') + desc;
    const s = parseTime_(d, ev.time);
    if (s) cal.createEvent(title, s, parseTime_(d, ev.end_time) || new Date(s.getTime() + 3600000), { description: evDesc });
    else cal.createAllDayEvent(title, d, { description: evDesc });
    out.push(ev.date + (ev.time ? ' ' + ev.time : '') + ' ' + ev.what);
  });
  (r.deadlines || []).forEach(dl => {
    const d = parseDate_(dl.date); if (!d) return;
    dates.add(dl.date);
    cal.createAllDayEvent('[통신문] 기한: ' + dl.what, d, { description: desc });
    out.push(dl.date + ' 기한: ' + dl.what);
  });
  (r.menus || []).forEach(m => {
    const d = parseDate_(m.date); if (!d) return;
    dates.add(m.date);
    cal.createAllDayEvent('[식단] ' + m.menu, d, { description: desc });
  });
  return { added: out, dates: Array.from(dates) };
}

function prependToDoc_(r, added, msg) {
  const doc = getOrCreateDoc_();
  const body = doc.getBody();
  const stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  const lines = [
    ['H', stamp + ' · ' + (r.title || KINDERGARTEN + ' 안내')],
    ['P', '요약: ' + (r.summary || '-')],
    ['P', '일정·기한(캘린더 등록): ' + (added.length ? added.join(' / ') : '-')],
    ['P', '준비물: ' + ((r.items && r.items.length) ? r.items.join(', ') : '-')],
    ['P', '식단: ' + ((r.menus && r.menus.length) ? r.menus.map(m => m.date + ' ' + m.menu).join(' / ') : '-')]
  ];
  if (r.uncertain) lines.push(['P', '확인 필요: ' + r.uncertain]);
  lines.push(['P', '원본 메일: ' + Utilities.formatDate(msg.getDate(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm') + ' · ' + msg.getSubject()]);
  lines.push(['P', '']);
  for (let i = lines.length - 1; i >= 0; i--) {
    const p = body.insertParagraph(0, lines[i][1]);
    p.setHeading(lines[i][0] === 'H' ? DocumentApp.ParagraphHeading.HEADING2 : DocumentApp.ParagraphHeading.NORMAL);
  }
  doc.saveAndClose();
}

function getOrCreateDoc_() {
  const files = DriveApp.getFilesByName(DOC_NAME);
  while (files.hasNext()) {
    const f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_DOCS && !f.isTrashed()) return DocumentApp.openById(f.getId());
  }
  return DocumentApp.create(DOC_NAME);
}
function parseDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}
function parseTime_(d, t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); if (!m) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), +m[1], +m[2]);
}
function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['runOnce', 'pushKinderFeed'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runOnce').timeBased().everyDays(1).atHour(21).inTimezone('Asia/Seoul').create();
  ScriptApp.newTrigger('pushKinderFeed').timeBased().everyDays(1).atHour(5).inTimezone('Asia/Seoul').create();
}
/**
 * 아랑유치원 6세반 다정한반(이다올) 통신문·식단 자동 정리 및 하이브리드 일일 브리핑
 * - Gmail → Gemini API → 캘린더 + 드라이브 문서(날짜별 줄바꿈 포맷) + HA 웹훅(entries + briefing) + 이메일
 * - 식단: 문서에서 정규식으로 1줄 정확 추출(AI 미사용)
 * - 일정·복장·준비물: 최근 문서 원문 + 캘린더 전체 일정 + 요일별 기본 복장 규칙을 Gemini로 교차 종합
 * - 실패 대비 Fallback: Gemini 호출 실패 시 대상 날짜 키워드 기반 정규식 원문 추출
 * - 30분 주기 변경 감지(새 메일 / 문서 수정 / 캘린더 변경) 시 즉시 HA 갱신 및 업데이트 이메일 재발송
 */

const KINDERGARTEN        = '아랑유치원';
const CAL_NAME            = '다올';     // 일정을 넣을 캘린더 이름 (없으면 자동 생성)
const MY_CLASS            = '다정한반';
const MY_AGE_GROUP        = '6세반';    // 해가 바뀌면 함께 수정 (예: 2027년 7세반)
const CHILD_NAME          = '다올';
const TZ                  = 'Asia/Seoul';

const BRIEFING_SUBJ_PFX   = '[다올 브리핑';
const SIM_SUBJ_PFX        = '[다올 모델 시뮬레이션';
const SEARCH_QUERY        = 'from:me to:me newer_than:3d -label:자동요약-처리됨 -subject:"[다올 브리핑" -subject:"[다올 모델 시뮬레이션"';
const LABEL_DONE          = '자동요약-처리됨';
const LABEL_SKIP          = '자동요약-관련없음';
const DOC_NAME            = '통신문 요약';

const MAX_THREADS         = 20;
const MAX_BYTES           = 14 * 1024 * 1024;
const DONE_KEY            = 'DONE_MSG_IDS';
const DONE_KEEP_MS        = 30 * 86400000;
const FEED_DAYS           = 10;         // HA entries 범위: 오늘 ~ +9일
const BRIEFING_DOC_CHARS  = 20000;      // 브리핑 Gemini에 넘길 최근 문서 최대 길이
const ATTACH_TYPES        = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/i;

// 기본 모델 (ScriptProperties의 GEMINI_MODEL / GEMINI_BRIEFING_MODEL 우선 사용)
const DEFAULT_MODEL       = 'gemini-4-neon';

// 상태 추적용 ScriptProperties 키
const PROP_DOC_ID         = 'DOC_FILE_ID';
const PROP_LAST_DOC_MS    = 'LAST_DOC_UPDATED_MS';
const PROP_LAST_CAL_HASH  = 'LAST_CAL_HASH';
const PROP_LAST_BRIEF_AT  = 'LAST_BRIEFING_AT';

const WEEKDAYS_KO = ['일', '월', '화', '수', '목', '금', '토'];

// 요일별 기본 등원 복장 (0=일 ~ 6=토)
const DEFAULT_DRESS_BY_DOW = {
  0: '등원 없음(주말)',
  1: '체육복',
  2: '원복',
  3: '체육복',
  4: '원복',
  5: '자유복',
  6: '등원 없음(주말)'
};

const DRESS_RULES_TEXT = [
  '- 월·수: 체육복',
  '- 화·목: 원복',
  '- 금: 자유복',
  '- 생일(생일잔치·본인 생일): 자유복',
  '- 우선순위: (1) 담임선생님 확정 답변 > (2) 가정통신문·주간계획안의 특정 행사 지정 복장(예: 현장학습 동복체육복) > (3) 생일 자유복 > (4) 요일별 기본 복장',
  '- 문서 간 복장 안내가 서로 충돌하면 임의로 버리지 말고 "복장 확인 필요(예: 원복 vs 체육복)" 형태로 반드시 명시'
].join('\n');

// ============================================================================
// 1. 진입점 (트리거 및 수동 실행용)
// ============================================================================

/**
 * 30분 주기 트리거: 새 메일·문서 수정·캘린더 변경 감지 시에만 브리핑 갱신 + HA 전송 + 업데이트 이메일 발송
 */
function syncAndCheckUpdates(options) {
  const opts = options || {};
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    console.warn('다른 동기화 작업이 실행 중이어서 이번 주기를 건너뜁니다.');
    return;
  }
  try {
    const cfg = getConfig_();
    const emailRes = processNewEmails_(cfg);

    const docFile = getOrCreateDocFile_(cfg.props);
    const curDocMs = String(docFile.getLastUpdated().getTime());
    const prevDocMs = cfg.props.getProperty(PROP_LAST_DOC_MS);
    const docChanged = prevDocMs !== null && curDocMs !== prevDocMs;

    const calSnapshot = collectCalendarSnapshot_();
    const prevCalHash = cfg.props.getProperty(PROP_LAST_CAL_HASH);
    const calChanged = prevCalHash !== null && calSnapshot.hash !== prevCalHash;

    const reasons = [];
    if (opts.reason) reasons.push(opts.reason);
    if (emailRes.relatedCount > 0) {
      reasons.push('새 메일 ' + emailRes.relatedCount + '건 반영(' + emailRes.titles.slice(0, 2).join(', ') + ')');
    } else if (docChanged) {
      reasons.push('통신문 요약 문서 수정 감지');
    }
    if (calChanged && emailRes.relatedCount === 0) {
      reasons.push('캘린더 일정 변경 감지');
    }

    const isFirstInit = prevDocMs === null || prevCalHash === null;
    const shouldRefresh = Boolean(opts.forceNotify || reasons.length > 0 || isFirstInit);

    if (!shouldRefresh) {
      console.log('변경 없음 — 브리핑 갱신 및 발송 생략');
      return;
    }

    const reasonText = reasons.length > 0 ? reasons.join(' + ') : '초기 동기화';
    const isUpdateAlert = !opts.isScheduled;
    const result = generateAndDispatchBriefing_(cfg, calSnapshot, {
      reason: reasonText,
      isUpdateAlert: isUpdateAlert,
      sendEmail: opts.sendEmail !== false
    });

    // 전송 성공 후 최신 스냅샷 저장 (다음 30분 주기 중복 발송 방지)
    cfg.props.setProperty(PROP_LAST_DOC_MS, String(getOrCreateDocFile_(cfg.props).getLastUpdated().getTime()));
    cfg.props.setProperty(PROP_LAST_CAL_HASH, collectCalendarSnapshot_().hash);
    cfg.props.setProperty(PROP_LAST_BRIEF_AT, result.briefing.generated_at);
  } finally {
    lock.releaseLock();
  }
}

/**
 * 매일 05시 정기 실행: 아침 브리핑 (오늘+내일) HA 전송 + 이메일 발송
 */
function runMorningBriefing() {
  syncAndCheckUpdates({
    forceNotify: true,
    isScheduled: true,
    reason: '아침 정기 브리핑',
    sendEmail: true
  });
}

/**
 * 매일 21시 정기 실행: 저녁 브리핑 (내일 대비+오늘 정리) HA 전송 + 이메일 발송
 */
function runEveningBriefing() {
  syncAndCheckUpdates({
    forceNotify: true,
    isScheduled: true,
    reason: '저녁 정기 브리핑',
    sendEmail: true
  });
}

/**
 * 기존 호환 진입점 (수동 실행 시 즉시 새 메일 처리 + 브리핑 갱신 + 이메일 발송)
 */
function runOnce() {
  syncAndCheckUpdates({
    forceNotify: true,
    isScheduled: false,
    reason: '수동 실행',
    sendEmail: true
  });
}

/**
 * 기존 호환 진입점: 캘린더 entries + 최신 하이브리드 briefing을 HA 웹훅으로 즉시 전송
 */
function pushKinderFeed() {
  const cfg = getConfig_();
  const calSnapshot = collectCalendarSnapshot_();
  generateAndDispatchBriefing_(cfg, calSnapshot, {
    reason: 'HA 피드 수동 갱신',
    isUpdateAlert: false,
    sendEmail: false
  });
}

/**
 * 트리거 일괄 재설치 (30분 변경 감지 + 매일 05시 아침 정기 + 매일 21시 저녁 정기)
 */
function installTrigger() {
  const managed = ['runOnce', 'pushKinderFeed', 'syncAndCheckUpdates', 'runMorningBriefing', 'runEveningBriefing'];
  ScriptApp.getProjectTriggers()
    .filter(t => managed.indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('syncAndCheckUpdates').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('runMorningBriefing').timeBased().everyDays(1).atHour(5).inTimezone(TZ).create();
  ScriptApp.newTrigger('runEveningBriefing').timeBased().everyDays(1).atHour(21).inTimezone(TZ).create();
  console.log('트리거 설치 완료: syncAndCheckUpdates(30분), runMorningBriefing(05시), runEveningBriefing(21시)');
}

// ============================================================================
// 2. 메일 파싱 · 캘린더 등록 · Docs 기록
// ============================================================================

function processNewEmails_(cfg) {
  const done = getOrCreateLabel_(LABEL_DONE);
  const skip = getOrCreateLabel_(LABEL_SKIP);
  const doneIds = loadDoneIds_(cfg.props);
  const touchedDates = new Set();
  const titles = [];
  let relatedCount = 0;

  GmailApp.search(SEARCH_QUERY, 0, MAX_THREADS).forEach(thread => {
    try {
      let related = false;
      thread.getMessages().forEach(msg => {
        const id = msg.getId();
        const subj = msg.getSubject() || '';
        // 자체 발송한 브리핑·시뮬레이션 메일 재처리(무한루프) 차단
        if (subj.indexOf(BRIEFING_SUBJ_PFX) === 0 || subj.indexOf(SIM_SUBJ_PFX) === 0) {
          doneIds[id] = { t: Date.now(), rel: false };
          saveDoneIds_(cfg.props, doneIds);
          return;
        }
        if (doneIds[id]) {
          if (doneIds[id].rel) related = true;
          return;
        }
        const r = analyzeMessage_(msg, cfg.apiKey, cfg.parseModel);
        const rel = !!(r && r.is_related);
        if (rel) {
          related = true;
          relatedCount++;
          titles.push(r.title || subj || KINDERGARTEN + ' 안내');
          const res = addCalendar_(r);
          res.dates.forEach(d => touchedDates.add(d));
          prependToDoc_(r, msg, cfg.props);
        }
        doneIds[id] = { t: Date.now(), rel: rel };
        saveDoneIds_(cfg.props, doneIds);
      });
      thread.addLabel(done);
      if (!related) thread.addLabel(skip);
    } catch (e) {
      console.error('메일 처리 실패: ' + thread.getFirstMessageSubject() + ' / ' + e);
    }
  });

  if (touchedDates.size > 0) {
    try {
      consolidateCalendarDates_(Array.from(touchedDates), cfg.apiKey, cfg.parseModel);
    } catch (e) {
      console.error('캘린더 중복 병합 실패: ' + e);
    }
  }

  return { relatedCount: relatedCount, touchedDates: Array.from(touchedDates), titles: titles };
}

function analyzeMessage_(msg, apiKey, model) {
  const res = analyzeMessageWithMeta_(msg, apiKey, model);
  return res ? res.data : null;
}

function analyzeMessageWithMeta_(msg, apiKey, model) {
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

  const today = getSeoulDateStr_(0);
  const prompt = [
    '아래 메일 본문과 첨부(PDF·사진)를 읽고 JSON으로만 답하세요. 오늘은 ' + today + '입니다.',
    '연도 없는 날짜는 오늘 기준 가장 가까운 미래(또는 당월) 날짜로 해석하세요.',
    '자녀는 ' + KINDERGARTEN + ' ' + MY_AGE_GROUP + ' ' + MY_CLASS + '(' + CHILD_NAME + ')입니다.',
    'events에는 전체 대상 행사와 ' + MY_CLASS + ' 또는 ' + MY_AGE_GROUP + ' 전체가 대상인 행사만 넣고, 다른 반·다른 연령만 대상인 행사는 빼세요. 대상이 불분명하면 넣으세요.',
    '신입생 모집·입학 접수·재원생 동생 대상 안내 등 재원 가정과 무관한 일정과 기한은 events·deadlines에서 빼세요.',
    '[필수 추출 규칙]',
    '1. 식단표(menus)는 날짜별로 오전간식·점심·오후간식·후식·음료·과일을 절대 누락하지 말고 한 줄로 빠짐없이 적으세요. (예: "오전간식: 바나나, 우유 / 점심: 현미밥, 미역국, 닭갈비, 김치 / 오후간식: 감자전, 보리차")',
    '2. 행사(events)에 지정 복장(원복·체육복·동복체육복·자유복 등)이나 하원시간 변경·장소·담임선생님 확정 답변이 있으면 dress와 note에 빠짐없이 적으세요.',
    '3. 준비물(items)은 해당 행사에 필요한 물품을 빠짐없이 적으세요.',
    '',
    '메일 제목: ' + msg.getSubject(),
    '메일 본문:\n' + (bodyText || '(없음)'),
    '',
    '응답 JSON 형식:',
    '{',
    '  "is_related": ' + KINDERGARTEN + '(또는 유치원 가정통신문·식단표·행사 안내·담임선생님 안내/답변)과 관련 있으면 true, 아니면 false,',
    '  "title": "문서 제목 또는 한 줄 설명",',
    '  "summary": "보호자가 알아야 할 핵심 3-5줄 (담임 답변·특이 복장·변경 사항 포함)",',
    '  "events": [{"date":"YYYY-MM-DD","time":"HH:MM 또는 빈 문자열","end_time":"HH:MM 또는 빈 문자열","what":"구체적 행사·장소 내용","dress":"지정 복장(명시된 경우만), 없으면 빈 문자열","items":"이 행사 준비물, 없으면 빈 문자열","note":"하원시간 변경·세부 안내, 없으면 빈 문자열"}],',
    '  "deadlines": [{"date":"YYYY-MM-DD","what":"제출·회신·납부 기한 내용(금액·방법 포함)"}],',
    '  "items": ["전체 준비물 목록"],',
    '  "menus": [{"date":"YYYY-MM-DD","menu":"오전간식·점심·오후간식·후식 빠짐없이 기록"}],',
    '  "uncertain": "읽기 어렵거나 날짜 해석이 불확실한 부분, 없으면 빈 문자열"',
    '}'
  ].join('\n');
  parts.push({ text: prompt });

  return callGeminiJsonWithMeta_(apiKey, model, parts);
}

function addCalendar_(r) {
  const cal = getTargetCalendar_();
  const baseDesc = (r.title || '') + '\n' + (r.summary || '') + '\n\n(자동 등록 — 날짜는 원문과 대조하세요)';
  const dates = new Set();

  (r.events || []).forEach(ev => {
    const d = parseDate_(ev.date); if (!d) return;
    dates.add(ev.date);
    const title = '[통신문] ' + ev.what;
    const itemTokens = [];
    if (ev.dress) itemTokens.push(ev.dress);
    if (ev.items && (!ev.dress || ev.items.indexOf(ev.dress) < 0)) itemTokens.push(ev.items);
    else if (ev.items && ev.dress && ev.items.indexOf(ev.dress) >= 0) {
      itemTokens.length = 0;
      itemTokens.push(ev.items);
    }
    const descParts = [];
    if (itemTokens.length) descParts.push('준비물: ' + itemTokens.join(', '));
    if (ev.note) descParts.push('메모: ' + ev.note);
    descParts.push(baseDesc);
    const evDesc = descParts.join('\n\n');

    const s = parseTime_(d, ev.time);
    if (s) cal.createEvent(title, s, parseTime_(d, ev.end_time) || new Date(s.getTime() + 3600000), { description: evDesc });
    else cal.createAllDayEvent(title, d, { description: evDesc });
  });

  (r.deadlines || []).forEach(dl => {
    const d = parseDate_(dl.date); if (!d) return;
    dates.add(dl.date);
    cal.createAllDayEvent('[통신문] 기한: ' + dl.what, d, { description: baseDesc });
  });

  (r.menus || []).forEach(m => {
    const d = parseDate_(m.date); if (!d) return;
    dates.add(m.date);
    cal.createAllDayEvent('[식단] ' + m.menu, d, { description: baseDesc });
  });

  return { dates: Array.from(dates) };
}

/**
 * '통신문 요약' 문서 최상단에 날짜별 줄바꿈 목록(- YYYY-MM-DD(요일) | 내용) 포맷으로 기록
 */
function prependToDoc_(r, msg, props) {
  const doc = getOrCreateDoc_(props);
  const body = doc.getBody();
  const stamp = getSeoulDateStr_(0);

  const scheduleRows = [];
  (r.events || []).forEach(ev => {
    if (!ev || !ev.date) return;
    const detailParts = [];
    if (ev.dress) detailParts.push('복장: ' + ev.dress);
    if (ev.items) detailParts.push('준비물: ' + ev.items);
    if (ev.note) detailParts.push('메모: ' + ev.note);
    const timePrefix = ev.time ? (ev.time + (ev.end_time ? '~' + ev.end_time : '') + ' ') : '';
    const suffix = detailParts.length ? ' (' + detailParts.join(' / ') + ')' : '';
    scheduleRows.push({
      date: ev.date,
      text: '- ' + formatDateWithDay_(ev.date) + ' | ' + timePrefix + (ev.what || '') + suffix
    });
  });
  (r.deadlines || []).forEach(dl => {
    if (!dl || !dl.date) return;
    scheduleRows.push({
      date: dl.date,
      text: '- ' + formatDateWithDay_(dl.date) + ' | 기한: ' + (dl.what || '')
    });
  });
  scheduleRows.sort((a, b) => a.date.localeCompare(b.date));

  const menuRows = (r.menus || [])
    .filter(m => m && m.date && m.menu)
    .map(m => ({
      date: m.date,
      text: '- ' + formatDateWithDay_(m.date) + ' | ' + m.menu.trim()
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const lines = [
    ['H', stamp + ' · ' + (r.title || KINDERGARTEN + ' 안내')],
    ['P', '요약: ' + (r.summary || '-')]
  ];

  if (scheduleRows.length > 0) {
    lines.push(['P', '일정·기한:']);
    scheduleRows.forEach(row => lines.push(['P', row.text]));
  } else {
    lines.push(['P', '일정·기한: -']);
  }

  lines.push(['P', '준비물: ' + ((r.items && r.items.length) ? r.items.join(', ') : '-')]);

  if (menuRows.length > 0) {
    lines.push(['P', '식단:']);
    menuRows.forEach(row => lines.push(['P', row.text]));
  } else {
    lines.push(['P', '식단: -']);
  }

  if (r.uncertain) lines.push(['P', '확인 필요: ' + r.uncertain]);
  lines.push(['P', '원본 메일: ' + Utilities.formatDate(msg.getDate(), TZ, 'yyyy-MM-dd HH:mm') + ' · ' + msg.getSubject()]);
  lines.push(['P', '']);

  for (let i = lines.length - 1; i >= 0; i--) {
    const p = body.insertParagraph(0, lines[i][1]);
    p.setHeading(lines[i][0] === 'H' ? DocumentApp.ParagraphHeading.HEADING2 : DocumentApp.ParagraphHeading.NORMAL);
  }
  doc.saveAndClose();
}

/**
 * 1회성 수동 실행용: 기존 '통신문 요약' 문서의 '/' 연결 문단을 날짜별 줄바꿈(- YYYY-MM-DD(요일) | 내용)으로 일괄 변환
 * - 변환 전 드라이브에 원본 백업 사본을 자동 생성
 */
function migrateDocFormatOnce() {
  const props = PropertiesService.getScriptProperties();
  const docFile = getOrCreateDocFile_(props);
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd_HHmm');
  const backup = docFile.makeCopy(DOC_NAME + ' (포맷변환 백업 ' + stamp + ')');
  console.log('백업 사본 생성 완료: ' + backup.getName() + ' (' + backup.getUrl() + ')');

  const doc = DocumentApp.openById(docFile.getId());
  const body = doc.getBody();
  const paras = body.getParagraphs();

  let convertedSections = 0;
  let createdBullets = 0;

  for (let i = paras.length - 1; i >= 0; i--) {
    const text = paras[i].getText().trim();
    const sm = /^(일정·기한(?:\([^)]*\))?):\s*(.+)$/.exec(text);
    const mm = /^(식단):\s*(.+)$/.exec(text);
    const match = sm || mm;
    if (!match) continue;

    const headerLabel = sm ? '일정·기한:' : '식단:';
    const rawBody = match[2].trim();
    if (!rawBody || rawBody === '-' || !/\d{4}-\d{2}-\d{2}/.test(rawBody)) continue;

    const bullets = convertLegacyLineToBullets_(rawBody);
    if (!bullets.length) continue;

    paras[i].setText(headerLabel);
    for (let k = bullets.length - 1; k >= 0; k--) {
      const bp = body.insertParagraph(i + 1, bullets[k]);
      bp.setHeading(DocumentApp.ParagraphHeading.NORMAL);
    }
    convertedSections++;
    createdBullets += bullets.length;
  }

  doc.saveAndClose();
  props.setProperty(PROP_LAST_DOC_MS, String(docFile.getLastUpdated().getTime()));
  console.log('문서 포맷 변환 완료: ' + convertedSections + '개 섹션 → ' + createdBullets + '줄 변환');
}

function convertLegacyLineToBullets_(rawBody) {
  const chunks = rawBody
    .split(/\s*\/\s*(?=\d{4}-\d{2}-\d{2}\b)/)
    .map(s => s.trim())
    .filter(Boolean);

  return chunks.map(chunk => {
    const m = /^(\d{4}-\d{2}-\d{2})(?:\([월화수목금토일]\))?\s*(?:\|\s*)?(.+)$/.exec(chunk);
    if (m) return '- ' + formatDateWithDay_(m[1]) + ' | ' + m[2].trim();
    return '- ' + chunk;
  });
}

// ============================================================================
// 3. 하이브리드 일일 브리핑 (정규식 식단 + Gemini 교차 종합 + Fallback)
// ============================================================================

function generateAndDispatchBriefing_(cfg, calSnapshot, options) {
  const opts = options || {};
  const generatedAt = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  const todayStr = getSeoulDateStr_(0);
  const tomorrowStr = getSeoulDateStr_(1);

  const doc = getOrCreateDoc_(cfg.props);
  const docText = doc.getBody().getText() || '';

  const todayCalEvents = calSnapshot.byDate[todayStr] || [];
  const tomorrowCalEvents = calSnapshot.byDate[tomorrowStr] || [];

  const todayBrief = buildDayBriefing_(todayStr, '오늘', docText, todayCalEvents, cfg.apiKey, cfg.briefingModel);
  const tomorrowBrief = buildDayBriefing_(tomorrowStr, '내일', docText, tomorrowCalEvents, cfg.apiKey, cfg.briefingModel);

  const briefing = {
    generated_at: generatedAt,
    reason: opts.reason || '정기 브리핑',
    model: cfg.briefingModel,
    today: todayBrief,
    tomorrow: tomorrowBrief,
    combined_speech: buildCombinedSpeech_(todayBrief, tomorrowBrief)
  };

  // A안: 기존 entries 배열 유지 + briefing 객체 추가
  pushHaWebhook_(calSnapshot.entries, briefing);

  if (opts.sendEmail) {
    try {
      sendBriefingEmail_(cfg.props, briefing, opts);
    } catch (e) {
      console.error('브리핑 이메일 발송 실패: ' + e);
    }
  }

  return { entriesCount: calSnapshot.entries.length, briefing: briefing };
}

/**
 * 특정 날짜 1일치 하이브리드 브리핑 생성
 * - 식단: 문서 정규식(우선) / 캘린더 [식단](보조)로 AI 없이 정확 추출
 * - 일정·복장·준비물: 최근 문서 원문 + 해당 날짜 캘린더 전체 일정 + 요일별 기본 복장 규칙을 Gemini로 교차 종합
 * - 실패 시 try-catch Fallback으로 원문 날짜 키워드 줄 + 캘린더 일정 반환
 */
function buildDayBriefing_(targetDateStr, dayLabel, docText, calEventsForDay, apiKey, model) {
  const weekday = getWeekdayKo_(targetDateStr);
  const dow = parseDate_(targetDateStr).getDay();
  const baseDress = DEFAULT_DRESS_BY_DOW[dow] || '';
  const isWeekend = dow === 0 || dow === 6;

  // 1) 식단: AI 미사용, 문서 정규식 직접 추출 (없으면 캘린더 [식단] 보조)
  let menu = extractMenuForDate_(docText, targetDateStr);
  if (!menu) {
    const menuEv = (calEventsForDay || []).find(ev => ev.kind === 'menu');
    if (menuEv) menu = menuEv.title;
  }

  // 2) 해당 날짜의 캘린더 일정(수동 입력 포함, [식단] 제외)
  const nonMenuCalEvents = (calEventsForDay || []).filter(ev => ev.kind !== 'menu');
  const calLines = nonMenuCalEvents.map(ev => {
    const timeTag = ev.time ? ev.time + (ev.endTime ? '~' + ev.endTime : '') : '종일';
    const kindTag = ev.kind === 'deadline' ? '[기한] ' : (ev.kind === 'manual' ? '[직접등록] ' : '');
    const descShort = ev.description ? ' | 메모: ' + ev.description.replace(/\s+/g, ' ').slice(0, 400) : '';
    return '- [' + timeTag + '] ' + kindTag + ev.title + descShort;
  });

  // 3) 일정·복장·준비물: Gemini 교차 종합 (+ 실패 시 Fallback)
  const recentDoc = (docText || '').slice(0, BRIEFING_DOC_CHARS);
  const prompt = [
    '당신은 ' + KINDERGARTEN + ' ' + MY_AGE_GROUP + ' ' + MY_CLASS + ' ' + CHILD_NAME + ' 원아의 보호자용 일일 브리핑 엔진입니다.',
    '대상 날짜는 ' + formatDateWithDay_(targetDateStr) + ' (' + dayLabel + ')입니다.',
    '아래 [복장 규칙], [대상 날짜 캘린더 일정], [통신문 요약 최근 원문]을 모두 교차 종합해 JSON으로만 답하세요.',
    '식단은 별도 시스템이 원문에서 직접 붙이므로 식단 내용은 추측하거나 지어내지 마세요.',
    '',
    '[복장 규칙]',
    DRESS_RULES_TEXT,
    '- 대상 날짜(' + weekday + '요일) 기본 복장: ' + baseDress,
    '',
    '[교차 종합 지침]',
    '1. 통신문 요약은 위쪽(상단)일수록 최신 문서입니다. 가정통신문·주간계획안·담임선생님 확정 답변에 흩어진 대상 날짜 관련 정보를 모두 합쳐 구체적으로 정리하세요.',
    '2. [직접등록] 캘린더 일정은 보호자가 직접 입력한 중요 일정이므로 반드시 events에 포함하세요.',
    '3. 현장학습·생일잔치·행사 시간·장소·하원시간 변경·개별 준비물·제출/납부 기한을 누락 없이 반영하세요.',
    '4. 타 반(예: 즐거운반) 전용 일정이나 대상 날짜와 무관한 다른 날 일정은 제외하세요.',
    '5. speech_schedule은 시리(Siri)가 음성으로 읽을 자연스러운 한국어 2~4문장입니다. 특수기호(*, #, -, /, 괄호) 없이 날짜, 등원 복장, 핵심 일정·준비물·기한만 간결하게 말하듯 작성하세요. (식단은 넣지 마세요)',
    '',
    '[대상 날짜 캘린더 일정]',
    calLines.length ? calLines.join('\n') : '(등록된 일정 없음)',
    '',
    '[통신문 요약 최근 원문]',
    recentDoc || '(문서 내용 없음)',
    '',
    '응답 JSON 형식:',
    '{',
    '  "is_school_day": true 또는 false (주말·공휴일·휴원일이면 false),',
    '  "dress": "최종 확정 복장 (충돌 시 복장 확인 필요(...) 포함, 등원 없으면 등원 없음)",',
    '  "dress_reason": "복장 판단 근거 1줄",',
    '  "events": ["시간·장소·구체 내용을 포함한 행사 요약 1", "..."],',
    '  "deadlines": ["기한·제출·납부 항목 1", "..."],',
    '  "items": ["준비물 1", "준비물 2"],',
    '  "notes": ["주의사항·하원 변경·담임 확정 답변 핵심"],',
    '  "speech_schedule": "시리 음성 브리핑용 일정·복장·준비물 요약 (식단 제외, 특수기호 제외)"',
    '}'
  ].join('\n');

  try {
    const res = callGeminiJsonWithMeta_(apiKey, model, [{ text: prompt }]);
    const d = res.data || {};
    const isSchoolDay = typeof d.is_school_day === 'boolean' ? d.is_school_day : !isWeekend;
    const dress = d.dress || baseDress;
    const speechSchedule = cleanSpeechText_(d.speech_schedule || '');
    const speech = buildFullDaySpeech_(targetDateStr, dayLabel, speechSchedule, menu, isSchoolDay);

    return {
      date: targetDateStr,
      weekday: weekday,
      is_school_day: isSchoolDay,
      dress: dress,
      dress_reason: d.dress_reason || (weekday + '요일 기본 규칙'),
      events: toStringArray_(d.events),
      deadlines: toStringArray_(d.deadlines),
      items: toStringArray_(d.items),
      notes: toStringArray_(d.notes),
      menu: menu,
      speech: speech,
      source: 'gemini',
      latency_ms: res.latencyMs,
      usage: res.usage || null
    };
  } catch (e) {
    console.error('브리핑 Gemini 실패 (' + targetDateStr + ') — Fallback 전환: ' + e);
    return buildFallbackBriefing_(targetDateStr, dayLabel, weekday, baseDress, isWeekend, docText, nonMenuCalEvents, menu, e);
  }
}

function buildFallbackBriefing_(targetDateStr, dayLabel, weekday, baseDress, isWeekend, docText, nonMenuCalEvents, menu, err) {
  const matchedLines = extractFallbackLines_(docText, targetDateStr);
  const events = [];
  const deadlines = [];

  nonMenuCalEvents.forEach(ev => {
    const prefix = ev.time ? ev.time + ' ' : '';
    if (ev.kind === 'deadline') deadlines.push(ev.title);
    else events.push(prefix + ev.title);
  });

  matchedLines.forEach(line => {
    if (events.indexOf(line) < 0 && deadlines.indexOf(line) < 0) {
      if (/기한\s*:/.test(line)) deadlines.push(line);
      else events.push(line);
    }
  });

  const parts = [];
  if (!isWeekend) parts.push('기본 복장은 ' + baseDress + '이며, 자동 종합에 실패해 원문을 확인해 주세요.');
  else parts.push('주말입니다.');
  if (events.length) parts.push('일정은 ' + events.slice(0, 3).join(', ') + ' 등이 있습니다.');
  if (deadlines.length) parts.push('기한 항목은 ' + deadlines.slice(0, 2).join(', ') + '입니다.');
  const speechSchedule = cleanSpeechText_(parts.join(' '));

  return {
    date: targetDateStr,
    weekday: weekday,
    is_school_day: !isWeekend,
    dress: baseDress + (isWeekend ? '' : ' (AI 실패 — 원문 확인 필요)'),
    dress_reason: 'Gemini 호출 실패로 기본 규칙 및 정규식 Fallback 적용',
    events: events,
    deadlines: deadlines,
    items: [],
    notes: ['자동 종합 오류: ' + String(err).slice(0, 160)],
    menu: menu,
    speech: buildFullDaySpeech_(targetDateStr, dayLabel, speechSchedule, menu, !isWeekend),
    source: 'fallback',
    error: String(err).slice(0, 200)
  };
}

/**
 * '통신문 요약' 문서에서 대상 날짜 식단 1줄을 AI 없이 정규식으로 정확 추출
 * - 신규 포맷(식단: 하위 '- YYYY-MM-DD(요일) | ...') 우선, 구 포맷('식단: YYYY-MM-DD ... / ...') 호환
 */
function extractMenuForDate_(docText, targetDateStr) {
  const lines = (docText || '').split(/\r?\n/);
  const escDate = escapeRegex_(targetDateStr);
  const bulletRe = new RegExp('^[-•*]\\s*' + escDate + '(?:\\([월화수목금토일]\\))?\\s*\\|\\s*(.+)$');
  const legacyLineRe = /^식단\s*:\s*(.+)$/;
  const legacyChunkRe = new RegExp('^' + escDate + '(?:\\([월화수목금토일]\\))?\\s*(?:\\|\\s*)?(.+)$');

  let inMenuSection = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { inMenuSection = false; continue; }
    if (/^식단\s*:?$/.test(line)) { inMenuSection = true; continue; }
    if (/^(요약|일정·기한|준비물|확인 필요|원본 메일|\d{4}-\d{2}-\d{2}\s*·)/.test(line)) {
      inMenuSection = false;
    }

    if (inMenuSection) {
      const m = bulletRe.exec(line);
      if (m) return m[1].trim();
    }

    // 구 포맷 호환: "식단: 2026-11-25 ... / 2026-11-26 ..."
    const lm = legacyLineRe.exec(line);
    if (lm && lm[1].trim() !== '-') {
      const chunks = lm[1].split(/\s*\/\s*(?=\d{4}-\d{2}-\d{2}\b)/);
      for (let c = 0; c < chunks.length; c++) {
        const cm = legacyChunkRe.exec(chunks[c].trim());
        if (cm) return cm[1].trim();
      }
    }
  }
  return '';
}

/**
 * Fallback용: 대상 날짜 키워드(YYYY-MM-DD, M월 D일, M/D, M.D)가 포함된 원문 줄 추출 (식단·원본메일 줄 제외)
 */
function extractFallbackLines_(docText, targetDateStr) {
  const d = parseDate_(targetDateStr);
  if (!d) return [];
  const month = d.getMonth() + 1;
  const day = d.getDate();

  const datePatterns = [
    escapeRegex_(targetDateStr),
    '(?<!\\d)0?' + month + '\\s*월\\s*0?' + day + '\\s*일',
    '(?<!\\d)0?' + month + '[/.]0?' + day + '(?!\\d)'
  ];
  const kwRe = new RegExp('(?:' + datePatterns.join('|') + ')');

  const lines = (docText || '').split(/\r?\n/);
  const matched = [];
  const seen = new Set();
  let inMenuSection = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { inMenuSection = false; continue; }
    if (/^식단\s*:?$/.test(line)) { inMenuSection = true; continue; }
    if (/^식단\s*:/.test(line)) { inMenuSection = false; continue; }
    if (/^(요약|일정·기한|준비물|확인 필요|원본 메일|\d{4}-\d{2}-\d{2}\s*·)/.test(line)) {
      inMenuSection = false;
    }
    if (inMenuSection) continue;
    if (/^원본 메일\s*:/.test(line)) continue;
    // H2 작성일 헤더("2026-11-25 · 제목")는 단순 작성일 매칭을 피하고, 제목 쪽에 날짜가 있을 때만 허용
    if (/^\d{4}-\d{2}-\d{2}\s*·/.test(line)) {
      const titlePart = line.replace(/^\d{4}-\d{2}-\d{2}\s*·\s*/, '');
      if (!kwRe.test(titlePart)) continue;
    }

    if (kwRe.test(line)) {
      const clean = line.replace(/^[-•*]\s*/, '');
      if (!seen.has(clean)) {
        seen.add(clean);
        matched.push(clean);
        if (matched.length >= 20) break;
      }
    }
  }
  return matched;
}

function buildFullDaySpeech_(dateStr, dayLabel, speechSchedule, menu, isSchoolDay) {
  const d = parseDate_(dateStr);
  const dateRead = (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + getWeekdayKo_(dateStr) + '요일';
  const parts = [dayLabel + ' ' + dateRead + ' ' + CHILD_NAME + '이 브리핑입니다.'];
  if (speechSchedule) parts.push(speechSchedule);
  if (menu) {
    parts.push('식단은 ' + cleanSpeechText_(menu) + '입니다.');
  } else if (isSchoolDay) {
    parts.push('등록된 식단은 없습니다.');
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function buildCombinedSpeech_(todayBrief, tomorrowBrief) {
  const parts = [todayBrief.speech];
  const tmwParts = [];
  if (tomorrowBrief.is_school_day) {
    tmwParts.push('내일 ' + tomorrowBrief.weekday + '요일 복장은 ' + cleanSpeechText_(tomorrowBrief.dress) + '입니다.');
  }
  if (tomorrowBrief.events.length) {
    tmwParts.push('내일 일정은 ' + cleanSpeechText_(tomorrowBrief.events.slice(0, 2).join(', ')) + '입니다.');
  }
  if (tomorrowBrief.deadlines.length) {
    tmwParts.push('내일 기한은 ' + cleanSpeechText_(tomorrowBrief.deadlines.slice(0, 2).join(', ')) + '입니다.');
  }
  if (tomorrowBrief.items.length) {
    tmwParts.push('내일 준비물은 ' + cleanSpeechText_(tomorrowBrief.items.join(', ')) + '입니다.');
  }
  if (tmwParts.length) parts.push('내일 예고입니다. ' + tmwParts.join(' '));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function cleanSpeechText_(s) {
  return String(s || '')
    .replace(/[*#_`~]/g, '')
    .replace(/\s*\/\s*/g, ', ')
    .replace(/\s*\|\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================================
// 4. HA 웹훅 전송 · 이메일 발송 · 캘린더 스냅샷/통합
// ============================================================================

function collectCalendarSnapshot_() {
  const todayStr = getSeoulDateStr_(0);
  const from = parseDate_(todayStr);
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + FEED_DAYS);

  const entries = [];
  const byDate = {};
  const hashLines = [];

  getTargetCalendar_().getEvents(from, to).forEach(ev => {
    const title = ev.getTitle() || '';
    const allDay = ev.isAllDayEvent();
    const start = allDay ? ev.getAllDayStartDate() : ev.getStartTime();
    const end = allDay ? ev.getAllDayEndDate() : ev.getEndTime();
    const d = Utilities.formatDate(start, TZ, 'yyyy-MM-dd');
    const t = allDay ? '' : Utilities.formatDate(start, TZ, 'HH:mm');
    const et = allDay ? '' : Utilities.formatDate(end, TZ, 'HH:mm');
    const desc = ev.getDescription() || '';

    hashLines.push([d, t, et, title, desc.slice(0, 300)].join('|'));

    let kind = 'manual';
    let cleanTitle = title;
    let m;
    if ((m = /^\[식단\]\s*(.*)$/.exec(title))) {
      kind = 'menu';
      cleanTitle = m[1].trim();
      entries.push({ d: d, t: '', k: 'menu', x: cleanTitle, i: '' });
    } else if ((m = /^\[통신문\]\s*기한:\s*(.*)$/.exec(title))) {
      kind = 'deadline';
      cleanTitle = m[1].trim();
      entries.push({ d: d, t: '', k: 'deadline', x: cleanTitle, i: '' });
    } else if ((m = /^\[통신문\]\s*(.*)$/.exec(title))) {
      kind = 'event';
      cleanTitle = m[1].trim();
      const im = /^준비물:\s*(.+)$/m.exec(desc);
      entries.push({ d: d, t: t, k: 'event', x: cleanTitle, i: im ? im[1].trim() : '' });
    }

    if (!byDate[d]) byDate[d] = [];
    byDate[d].push({
      date: d,
      time: t,
      endTime: et,
      kind: kind,
      title: cleanTitle,
      rawTitle: title,
      description: desc
    });
  });

  dedupeFeedItems_(entries);
  hashLines.sort();
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, hashLines.join('\n'), Utilities.Charset.UTF_8);
  const hash = digest.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');

  return { entries: entries, byDate: byDate, hash: hash };
}

function pushHaWebhook_(entries, briefing) {
  const url = PropertiesService.getScriptProperties().getProperty('HA_WEBHOOK_URL');
  if (!url) {
    console.warn('스크립트 속성 HA_WEBHOOK_URL 없음 — HA 전송 생략');
    return;
  }
  const payload = { entries: entries, briefing: briefing };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  console.log('HA 전송: entries ' + entries.length + '건 + briefing → HTTP ' + res.getResponseCode());
  if (res.getResponseCode() >= 300) {
    throw new Error('HA 웹훅 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
}

function sendBriefingEmail_(props, briefing, opts) {
  const to = props.getProperty('BRIEFING_EMAIL') || Session.getEffectiveUser().getEmail();
  if (!to) {
    console.warn('이메일 수신처가 없어 발송을 생략합니다.');
    return;
  }

  const timeHm = briefing.generated_at.slice(11, 16);
  const tag = opts.isUpdateAlert ? '업데이트' : '정기';
  const subject = BRIEFING_SUBJ_PFX + ' ' + tag + '] ' +
    formatDateWithDay_(briefing.today.date) + ' · ' + timeHm + ' (' + briefing.reason + ')';

  const plainBody = [
    '[' + KINDERGARTEN + ' ' + CHILD_NAME + ' 일일 브리핑]',
    '업데이트 시각: ' + briefing.generated_at,
    '업데이트 사유: ' + briefing.reason,
    '사용 모델: ' + briefing.model + ' (오늘: ' + briefing.today.source + ' / 내일: ' + briefing.tomorrow.source + ')',
    '',
    formatDayPlain_('오늘', briefing.today),
    '',
    formatDayPlain_('내일', briefing.tomorrow)
  ].join('\n');

  const htmlBody = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:680px;line-height:1.6;color:#222;">',
    '<div style="background:#f4f6f9;border-left:4px solid #2563eb;padding:12px 16px;margin-bottom:16px;border-radius:4px;">',
    '<strong>' + escapeHtml_(KINDERGARTEN + ' ' + CHILD_NAME + ' 일일 브리핑') + '</strong><br/>',
    '<span style="font-size:13px;color:#555;">업데이트 시각: <b>' + escapeHtml_(briefing.generated_at) + '</b> · 사유: ' + escapeHtml_(briefing.reason) + '</span><br/>',
    '<span style="font-size:12px;color:#666;">모델: ' + escapeHtml_(briefing.model) + ' (오늘: ' + escapeHtml_(briefing.today.source) + ' / 내일: ' + escapeHtml_(briefing.tomorrow.source) + ')</span>',
    '</div>',
    formatDayHtml_('오늘', briefing.today, '#2563eb'),
    formatDayHtml_('내일', briefing.tomorrow, '#0f766e'),
    '</div>'
  ].join('\n');

  MailApp.sendEmail({
    to: to,
    subject: subject,
    body: plainBody,
    htmlBody: htmlBody
  });
  console.log('브리핑 이메일 발송 완료: ' + to + ' / ' + subject);
}

function formatDayPlain_(label, b) {
  return [
    '■ ' + label + ' (' + formatDateWithDay_(b.date) + ') [' + b.source + ']',
    '- 복장: ' + b.dress + (b.dress_reason ? ' (' + b.dress_reason + ')' : ''),
    '- 일정: ' + (b.events.length ? '\n  · ' + b.events.join('\n  · ') : '없음'),
    '- 기한: ' + (b.deadlines.length ? '\n  · ' + b.deadlines.join('\n  · ') : '없음'),
    '- 준비물: ' + (b.items.length ? b.items.join(', ') : '없음'),
    '- 식단: ' + (b.menu || '없음'),
    b.notes.length ? ('- 메모: ' + b.notes.join(' / ')) : '',
    '- 시리 브리핑: ' + b.speech
  ].filter(Boolean).join('\n');
}

function formatDayHtml_(label, b, accentColor) {
  const listHtml = arr => arr.length
    ? '<ul style="margin:4px 0 8px 18px;padding:0;">' + arr.map(x => '<li>' + escapeHtml_(x) + '</li>').join('') + '</ul>'
    : '<span style="color:#888;">없음</span>';
  const warnStyle = /복장 확인 필요|실패/.test(b.dress) ? 'color:#dc2626;font-weight:bold;' : 'font-weight:bold;';

  return [
    '<div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:16px;">',
    '<h3 style="margin:0 0 10px 0;color:' + accentColor + ';">' + escapeHtml_(label + ' · ' + formatDateWithDay_(b.date)) + '</h3>',
    '<p style="margin:4px 0;"><b>복장:</b> <span style="' + warnStyle + '">' + escapeHtml_(b.dress) + '</span>' +
      (b.dress_reason ? ' <span style="font-size:12px;color:#666;">(' + escapeHtml_(b.dress_reason) + ')</span>' : '') + '</p>',
    '<p style="margin:6px 0 2px 0;"><b>일정:</b></p>' + listHtml(b.events),
    '<p style="margin:6px 0 2px 0;"><b>기한:</b></p>' + listHtml(b.deadlines),
    '<p style="margin:6px 0;"><b>준비물:</b> ' + escapeHtml_(b.items.length ? b.items.join(', ') : '없음') + '</p>',
    '<p style="margin:6px 0;"><b>식단:</b> ' + escapeHtml_(b.menu || '없음') + '</p>',
    b.notes.length ? ('<p style="margin:6px 0;"><b>메모:</b> ' + escapeHtml_(b.notes.join(' / ')) + '</p>') : '',
    '<div style="background:#f9fafb;padding:8px 10px;border-radius:6px;margin-top:8px;font-size:13px;color:#444;">',
    '<b>시리 브리핑:</b> ' + escapeHtml_(b.speech),
    '</div>',
    '</div>'
  ].join('\n');
}

// ============================================================================
// 5. Gemini 모델 탐색 및 모델별 시뮬레이션 (브리핑 / 자료 파싱)
// ============================================================================

/**
 * 현재 API 키로 호출 가능한 Gemini 모델 목록 조회 (로그 출력 + 배열 반환)
 */
function listAvailableGeminiModels() {
  const cfg = getConfig_();
  const url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100';
  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { 'x-goog-api-key': cfg.apiKey },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('모델 목록 조회 실패 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  const body = JSON.parse(res.getContentText());
  const models = (body.models || [])
    .filter(m => m.name && m.supportedGenerationMethods && m.supportedGenerationMethods.indexOf('generateContent') >= 0)
    .filter(m => /gemini/i.test(m.name))
    .map(m => ({
      id: m.name.replace(/^models\//, ''),
      displayName: m.displayName || '',
      inputTokenLimit: m.inputTokenLimit || 0
    }));

  models.forEach(m => console.log(m.id + ' | ' + m.displayName + ' | in:' + m.inputTokenLimit));
  return models;
}

/**
 * 모델별 브리핑 시뮬레이션 (실제 '통신문 요약' + '다올' 캘린더로 내일 브리핑 비교, HA/문서 변경 없음)
 * - ScriptProperties 'SIMULATION_MODELS'(쉼표 구분) 또는 인자 배열 사용, 미지정 시 Gemini 4/Pro/Flash 자동 선택
 * - 비교 결과를 로그 출력 + 이메일 발송
 */
function simulateBriefingModels(customModels) {
  const cfg = getConfig_();
  const candidates = resolveSimulationModels_(cfg, customModels);
  const targetDateStr = getSeoulDateStr_(1); // 내일 기준 시뮬레이션
  const docText = getOrCreateDoc_(cfg.props).getBody().getText() || '';
  const calSnapshot = collectCalendarSnapshot_();
  const calEvents = calSnapshot.byDate[targetDateStr] || [];

  const results = candidates.map(model => {
    const startMs = Date.now();
    const out = buildDayBriefing_(targetDateStr, '내일', docText, calEvents, cfg.apiKey, model);
    return {
      model: model,
      source: out.source,
      latencyMs: out.latency_ms || (Date.now() - startMs),
      usage: out.usage || null,
      dress: out.dress,
      dressReason: out.dress_reason,
      events: out.events,
      deadlines: out.deadlines,
      items: out.items,
      notes: out.notes,
      speech: out.speech,
      error: out.error || ''
    };
  });

  const reportLines = [
    '[브리핑 모델 시뮬레이션] 대상 날짜: ' + formatDateWithDay_(targetDateStr),
    '실행 시각: ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
    '테스트 모델: ' + candidates.join(', '),
    ''
  ];

  results.forEach(r => {
    const tok = r.usage ? ('in:' + (r.usage.promptTokenCount || 0) + ' / out:' + (r.usage.candidatesTokenCount || 0)) : '-';
    reportLines.push('========================================');
    reportLines.push('모델: ' + r.model + ' | 상태: ' + r.source + ' | 시간: ' + r.latencyMs + 'ms | 토큰: ' + tok);
    if (r.error) reportLines.push('오류: ' + r.error);
    reportLines.push('복장: ' + r.dress + ' (' + r.dressReason + ')');
    reportLines.push('일정: ' + (r.events.length ? r.events.join(' / ') : '없음'));
    reportLines.push('기한: ' + (r.deadlines.length ? r.deadlines.join(' / ') : '없음'));
    reportLines.push('준비물: ' + (r.items.length ? r.items.join(', ') : '없음'));
    if (r.notes.length) reportLines.push('메모: ' + r.notes.join(' / '));
    reportLines.push('시리 문구: ' + r.speech);
    reportLines.push('');
  });

  const report = reportLines.join('\n');
  console.log(report);
  sendSimulationEmail_(cfg.props, '브리핑 비교 (' + targetDateStr + ')', report);
  return results;
}

/**
 * 모델별 메일·첨부 파싱 시뮬레이션 (가장 최근 처리된 아랑유치원 메일 1건 기준, 캘린더/Docs 변경 없음)
 */
function simulateParseModels(customModels) {
  const cfg = getConfig_();
  const candidates = resolveSimulationModels_(cfg, customModels);
  const threads = GmailApp.search('from:me to:me label:' + LABEL_DONE + ' -label:' + LABEL_SKIP, 0, 5);
  let targetMsg = null;
  for (let i = 0; i < threads.length && !targetMsg; i++) {
    const msgs = threads[i].getMessages();
    for (let j = msgs.length - 1; j >= 0; j--) {
      const subj = msgs[j].getSubject() || '';
      if (subj.indexOf(BRIEFING_SUBJ_PFX) === 0 || subj.indexOf(SIM_SUBJ_PFX) === 0) continue;
      targetMsg = msgs[j];
      break;
    }
  }
  if (!targetMsg) throw new Error('시뮬레이션할 최근 처리 메일을 찾지 못했습니다.');

  const reportLines = [
    '[자료 파싱 모델 시뮬레이션]',
    '대상 메일: ' + Utilities.formatDate(targetMsg.getDate(), TZ, 'yyyy-MM-dd HH:mm') + ' · ' + targetMsg.getSubject(),
    '첨부 개수: ' + targetMsg.getAttachments({ includeInlineImages: true }).length,
    '테스트 모델: ' + candidates.join(', '),
    ''
  ];

  candidates.forEach(model => {
    reportLines.push('========================================');
    try {
      const res = analyzeMessageWithMeta_(targetMsg, cfg.apiKey, model);
      const d = (res && res.data) || {};
      const tok = res && res.usage ? ('in:' + (res.usage.promptTokenCount || 0) + ' / out:' + (res.usage.candidatesTokenCount || 0)) : '-';
      reportLines.push('모델: ' + model + ' | 성공 | 시간: ' + (res ? res.latencyMs : 0) + 'ms | 토큰: ' + tok);
      reportLines.push('제목: ' + (d.title || '-'));
      reportLines.push('요약: ' + (d.summary || '-'));
      reportLines.push('일정(' + (d.events || []).length + '): ' + JSON.stringify(d.events || []));
      reportLines.push('기한(' + (d.deadlines || []).length + '): ' + JSON.stringify(d.deadlines || []));
      reportLines.push('식단(' + (d.menus || []).length + '): ' + JSON.stringify((d.menus || []).slice(0, 3)));
      if (d.uncertain) reportLines.push('불확실: ' + d.uncertain);
    } catch (e) {
      reportLines.push('모델: ' + model + ' | 실패: ' + e);
    }
    reportLines.push('');
  });

  const report = reportLines.join('\n');
  console.log(report);
  sendSimulationEmail_(cfg.props, '자료 파싱 비교', report);
}

function resolveSimulationModels_(cfg, customModels) {
  if (Array.isArray(customModels) && customModels.length > 0) return customModels;
  const fromProp = cfg.props.getProperty('SIMULATION_MODELS');
  if (fromProp) {
    const list = fromProp.split(',').map(s => s.trim()).filter(Boolean);
    if (list.length > 0) return list;
  }

  // 미지정 시 API에서 Gemini 4 우선 + 현재 설정 모델 자동 선택 (최대 6개)
  const picked = [];
  const addUnique = id => { if (id && picked.indexOf(id) < 0) picked.push(id); };
  addUnique(cfg.parseModel);
  try {
    const available = listAvailableGeminiModels().map(m => m.id);
    available.filter(id => /^gemini-4/i.test(id)).forEach(addUnique);
    available.filter(id => /^gemini-3/i.test(id) && /(pro|flash)/i.test(id)).slice(0, 2).forEach(addUnique);
    available.filter(id => /^gemini-2\.5-(pro|flash)$/i.test(id)).forEach(addUnique);
  } catch (e) {
    console.warn('모델 자동 탐색 실패 — 기본 목록 사용: ' + e);
    addUnique('gemini-2.5-pro');
    addUnique('gemini-2.5-flash');
  }
  return picked.slice(0, 6);
}

function sendSimulationEmail_(props, titleSuffix, bodyText) {
  const to = props.getProperty('BRIEFING_EMAIL') || Session.getEffectiveUser().getEmail();
  if (!to) return;
  MailApp.sendEmail({
    to: to,
    subject: SIM_SUBJ_PFX + '] ' + titleSuffix,
    body: bodyText
  });
}

// ============================================================================
// 6. 기존 캘린더 중복 통합 · 준비물 정규화 · 유틸리티
// ============================================================================

/**
 * 1회 수동 실행용: 이미 '다올' 캘린더에 들어가 있는 오늘~30일 뒤 일정의 중복을 즉시 정리하고 HA로 전송
 */
function consolidateCalendarNow() {
  const cfg = getConfig_();
  const from = parseDate_(getSeoulDateStr_(0));
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 30);
  const dates = new Set();

  getTargetCalendar_().getEvents(from, to).forEach(ev => {
    if (!/^\[(통신문|식단)\]/.test(ev.getTitle())) return;
    const start = ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime();
    dates.add(Utilities.formatDate(start, TZ, 'yyyy-MM-dd'));
  });

  if (dates.size > 0) {
    consolidateCalendarDates_(Array.from(dates).sort(), cfg.apiKey, cfg.parseModel);
  }
  pushKinderFeed();
}

function consolidateCalendarDates_(dateStrings, apiKey, model) {
  const cal = getTargetCalendar_();
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
      if (Utilities.formatDate(start, TZ, 'yyyy-MM-dd') !== dateStr) return;
      const title = ev.getTitle();
      if (/^\[식단\]/.test(title)) menuEvs.push(ev);
      else if (/^\[통신문\]/.test(title)) noticeEvs.push(ev);
    });

    if (menuEvs.length > 1) {
      menuEvs.sort((a, b) => b.getTitle().length - a.getTitle().length);
      for (let i = 1; i < menuEvs.length; i++) menuEvs[i].deleteEvent();
    }

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
            time: allDay ? '' : Utilities.formatDate(ev.getStartTime(), TZ, 'HH:mm'),
            end_time: allDay ? '' : Utilities.formatDate(ev.getEndTime(), TZ, 'HH:mm'),
            what: title.replace(/^\[통신문\]\s*(기한:\s*)?/, '').trim(),
            items: im ? im[1].trim() : '',
            desc: desc.slice(0, 400)
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
    '1. 같은 날짜의 동일 행사·안내는 반드시 1건으로 병합하세요.',
    '2. 병합 시 장소·시간·정확한 금액 등 가장 구체적인 표현을 채택하세요.',
    '3. 실제로 서로 다른 행사는 각각 유지하되, 두 문서에 걸쳐 중복된 항목은 합치세요.',
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

    let unique = Array.from(new Set(allTokens));
    unique = unique.filter(item => {
      const norm = item.replace(/\s+/g, '');
      return !unique.some(other => {
        if (other === item) return false;
        const normOther = other.replace(/\s+/g, '');
        return normOther.includes(norm) && normOther.length > norm.length;
      });
    });

    const hasUniform = unique.some(s => s.includes('원복'));
    const hasGym = unique.some(s => s.includes('체육복'));
    const hasWarn = unique.some(s => s.includes('복장 확인'));
    if (hasUniform && hasGym && !hasWarn) {
      unique.push('복장 확인 필요(원복·체육복 혼재)');
    }

    evList[0].i = unique.join(', ');
    for (let idx = 1; idx < evList.length; idx++) {
      evList[idx].i = '';
    }
  });
}

function callGeminiJson_(apiKey, model, parts) {
  return callGeminiJsonWithMeta_(apiKey, model, parts).data;
}

function callGeminiJsonWithMeta_(apiKey, model, parts) {
  const startMs = Date.now();
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
  const latencyMs = Date.now() - startMs;

  if (res.getResponseCode() !== 200) {
    throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  const body = JSON.parse(res.getContentText());
  const cand = body.candidates && body.candidates[0];
  if (!cand || !cand.content || !cand.content.parts) {
    const why = (cand && cand.finishReason) || (body.promptFeedback && body.promptFeedback.blockReason) || 'unknown';
    throw new Error('Gemini 빈 응답: ' + why);
  }
  const rawText = cand.content.parts.map(p => p.text || '').join('').trim();
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return {
    data: JSON.parse(cleaned),
    latencyMs: latencyMs,
    usage: body.usageMetadata || null
  };
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('스크립트 속성 GEMINI_API_KEY가 없습니다.');
  const parseModel = props.getProperty('GEMINI_MODEL') || DEFAULT_MODEL;
  const briefingModel = props.getProperty('GEMINI_BRIEFING_MODEL') || parseModel;
  return { props: props, apiKey: apiKey, parseModel: parseModel, briefingModel: briefingModel };
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

function getTargetCalendar_() {
  const list = CalendarApp.getCalendarsByName(CAL_NAME);
  if (list.length) return list[0];
  return CalendarApp.createCalendar(CAL_NAME, { timeZone: TZ });
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

function getOrCreateDocFile_(props) {
  const p = props || PropertiesService.getScriptProperties();
  const cachedId = p.getProperty(PROP_DOC_ID);
  if (cachedId) {
    try {
      const f = DriveApp.getFileById(cachedId);
      if (f && !f.isTrashed() && f.getMimeType() === MimeType.GOOGLE_DOCS) return f;
    } catch (e) { /* 캐시 무효화 후 이름으로 재탐색 */ }
  }
  const files = DriveApp.getFilesByName(DOC_NAME);
  while (files.hasNext()) {
    const f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_DOCS && !f.isTrashed()) {
      p.setProperty(PROP_DOC_ID, f.getId());
      return f;
    }
  }
  const created = DocumentApp.create(DOC_NAME);
  p.setProperty(PROP_DOC_ID, created.getId());
  return DriveApp.getFileById(created.getId());
}

function getOrCreateDoc_(props) {
  return DocumentApp.openById(getOrCreateDocFile_(props).getId());
}

function getSeoulDateStr_(offsetDays) {
  const todayStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(todayStr);
  const d = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  d.setDate(d.getDate() + (offsetDays || 0));
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

function parseDate_(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
}

function parseTime_(d, t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); if (!m) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), +m[1], +m[2]);
}

function getWeekdayKo_(dateStr) {
  const d = parseDate_(dateStr);
  return d ? WEEKDAYS_KO[d.getDay()] : '';
}

function formatDateWithDay_(dateStr) {
  const w = getWeekdayKo_(dateStr);
  return w ? (dateStr + '(' + w + ')') : dateStr;
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function escapeRegex_(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toStringArray_(val) {
  if (!Array.isArray(val)) return [];
  return val.map(x => String(x || '').trim()).filter(Boolean);
}
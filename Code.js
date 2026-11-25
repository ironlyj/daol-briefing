/**
 * 아랑유치원 6세반 다정한반(이다올) 통신문·식단 자동 정리 및 하이브리드 일일 브리핑
 * - Gmail → Gemini API → 캘린더 + 드라이브 문서(날짜별 줄바꿈 포맷) + HA 웹훅(entries + briefing) + 이메일
 * - 식단: 문서에서 정규식으로 1줄 정확 추출(AI 미사용)
 * - 일정·복장·준비물: 최근 문서 원문 + 캘린더 전체 일정 + 요일별 기본 복장 규칙을 Gemini로 교차 종합
 * - 실패 대비 Fallback: Gemini 호출 실패 시 대상 날짜 키워드 기반 정규식 원문 추출
 * - 30분 주기 변경 감지(새 메일 / 문서 수정 / 캘린더 변경) 시 즉시 HA 갱신 및 업데이트 이메일 재발송
 *
 * 2026-11-25 수정
 *  1 정기 브리핑 락 대기 5분 + 실패 시 예외   2 자정 캘린더 창 이동 오탐 방지(LAST_CAL_DAY)
 *  3 HA 실패 시에도 메일·스냅샷 진행         4 파싱: 수신일 기준, 날짜 추정 금지
 *  5 시리 문구: 날짜 반복·오늘/내일 혼동 방지  6 thinking 토큰 기록, GEMINI_THINKING_LEVEL / GEMINI_TEMPERATURE 속성
 *  7 429·5xx 재시도, thinkingLevel 미지원 시 자동 제외  8 일정 없는 주말 Gemini 생략
 *  9 브리핑 시뮬레이션을 운영 경로(오늘+내일+combined_speech)로, 시뮬레이션은 Gemini 4만
 * 10 캘린더 병합: 생성 성공 후 삭제         11 기본 모델 gemini-4-hydrogen (운영은 속성 GEMINI_MODEL=gemini-4-argon)
 *
 * 2026-11-25 추가 수정 (메일 누락 방지·시리 문구)
 *  - 검색 창 7일, 메시지 단위 실패 격리(실패 메일은 라벨 없이 7일간 재시도), 7일 넘은 스레드 내 옛 메시지 재처리 방지
 *  - 제목 없는 복붙 메일: 짧은 본문도 처리, 관련 여부 애매하면 '관련'으로, 읽지 못한 첨부(HWP 등)는 확인 필요에 기록
 *  - 브리핑 메일에 '처리 실패' + '최근 24시간 관련없음 판정' 메일 목록 표시 (PARSE_LOG)
 *  - 시리: 내일 예고의 기한은 '내일 마감'만, 날짜·시각을 읽기 쉬운 말로 변환, 특정 안 된 준비물은 '확인 필요'
 *  - 파싱 시뮬레이션: 제목 대신 날짜·본문 키워드·첨부 여부로 대상 선택 (simParse* 함수)
 *
 * 2026-11-25 3차 (PDF·스캔은 AI 추출 → 코드 후처리 postProcessParse_)
 *  - 돈 내는 항목: 캘린더·문서엔 기록, 캘린더 알림 끔, 브리핑·시리·HA 피드에서 제외 (PAYMENT_RE)
 *  - 동기(2021년생 반) 생일: [생일] 캘린더 + 브리핑·시리 "○○ 친구 생일" (SAME_AGE_CLASSES는 학년 바뀌면 수정)
 *  - 식단표: 요약 없이 날짜·메뉴만, 알레르기 번호·기호 제거, 날짜 검증
 *  - 계좌번호·예금주 제거, 파싱에도 '원문에 없는 해석 금지'
 *  - 격려 문장(cheers): '오늘' 브리핑 호출에서 6개 생성(일정·생일 반영) → HA가 호출 때마다 무작위로 하나 읽음
 *  - 활동 사진: 메일로 보낸 유치원 활동 사진에서 활동 한 줄 메모를 뽑아 ACTIVITY_LOG에 보관(14일), 최근 3일을 격려 문장·브리핑 메일에 참고
 *  - 격려 문장: 아침용(cheers)·오후용(cheers_pm) 분리, 구글 문서 '다올 격려 문장 지침'의 지침과 날짜별 '꼭 말할 것'(cheer_must) 반영
 *  - 토큰 사용량 기록(USAGE_LOG) + 매주 월 08시 사용량·추정비용 메일(CSV 첨부, 브리핑과 별도) — installTrigger 재실행 필요
 *  - 격려 문장 기록을 구글 문서 로그 → 시트 '다올 격려 문장 평가'로 변경. 문장마다 좋음·나쁨 체크박스+메모,
 *    체크한 문장(최근 400행에서 각 8개)을 다음 생성 프롬프트에 '이런 느낌으로/이런 건 피하기'로 넣음 (CHEER_SHEET_ID)
 */

const KINDERGARTEN        = '아랑유치원';
const CAL_NAME            = '다올';     // 일정을 넣을 캘린더 이름 (없으면 자동 생성)
const MY_CLASS            = '다정한반';
const MY_AGE_GROUP        = '6세반';    // 해가 바뀌면 함께 수정 (예: 2027년 7세반)
const CHILD_NAME          = '다올';
const CHILD_BIRTHDAY_MD   = '10-12';    // 다올이 생일(월-일). 격려 문장에서 생일 축하에 사용
const CHILD_BIRTH_YEAR    = 2021;       // 다올이 출생연도. 동기(같은 해 출생) 생일만 알림
// 같은 연령(2021년생) 반 목록. 해가 바뀌어 반 이름이 바뀌면 수정 (2026학년도 6세반 기준)
const SAME_AGE_CLASSES    = ['명랑한반', '신나는반', '다정한반'];
const LABEL_BIRTHDAY      = '[생일]';   // 캘린더 생일 일정 제목 접두어
const TZ                  = 'Asia/Seoul';

const BRIEFING_SUBJ_PFX   = '[다올 브리핑';
const SIM_SUBJ_PFX        = '[다올 모델 시뮬레이션';
const SEARCH_QUERY        = 'from:me to:me newer_than:7d -label:자동요약-처리됨 -subject:"[다올 브리핑" -subject:"[다올 모델 시뮬레이션"';
const LABEL_DONE          = '자동요약-처리됨';
const LABEL_SKIP          = '자동요약-관련없음';
const DOC_NAME            = '통신문 요약';

const MAX_THREADS         = 20;
const MAX_BYTES           = 13 * 1024 * 1024;  // 첨부 원본 합계 한도. base64로 약 1.33배 → 약 17.3MB (Gemini 인라인 요청 한도 20MB로 알려짐, 최신 한도 미확인)
const DONE_KEY            = 'DONE_MSG_IDS';
const PARSE_LOG_KEY       = 'PARSE_LOG';            // 관련없음 판정·처리 실패 메일 기록 (브리핑 메일에 표시)
const LOOKBACK_DAYS       = 7;                      // 검색 창과 동일. 이보다 오래된 스레드 내 메시지는 재처리하지 않음
const DONE_KEEP_MS        = 30 * 86400000;
const FEED_DAYS           = 10;         // HA entries 범위: 오늘 ~ +9일
const BRIEFING_DOC_CHARS  = 20000;      // 브리핑 Gemini에 넘길 최근 문서 최대 길이
const ATTACH_TYPES        = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif))$/i;

// 기본 모델 (ScriptProperties의 GEMINI_MODEL / GEMINI_BRIEFING_MODEL 우선 사용)
const DEFAULT_MODEL       = 'gemini-4-hydrogen';

// 상태 추적용 ScriptProperties 키
const PROP_DOC_ID         = 'DOC_FILE_ID';
const PROP_LAST_DOC_MS    = 'LAST_DOC_UPDATED_MS';
const PROP_LAST_CAL_HASH  = 'LAST_CAL_HASH';
const PROP_LAST_BRIEF_AT  = 'LAST_BRIEFING_AT';
const PROP_LAST_CAL_DAY   = 'LAST_CAL_DAY';     // 캘린더 해시 기준 날짜 (자정 롤오버 오탐 방지)

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

// 돈 내는 항목(교육비·납부·자동이체 등) 판별 — 브리핑·시리·HA 알림에서 제외 (캘린더·문서 기록은 유지, 캘린더 알림 없음)
const PAYMENT_RE = /(교육비|원비|급식비|간식비|재료비|교재비|활동비|이용료|차량비|수납|납부|납입|자동\s*이체|출금|재인출|입금|결제|환불|\d{1,3}(,\d{3})+\s*원|\d+\s*만\s*원)/;

function isPaymentText_(s) {
  return PAYMENT_RE.test(String(s || ''));
}

// 시리 문장에서 돈 관련 문장만 제거
function dropPaymentSentences_(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map(x => x.trim())
    .filter(x => x && !isPaymentText_(x))
    .join(' ');
}

// 식단 정리: 알레르기 번호(①~⑳, (5.6) 등)·기호(◆★●) 제거, 구분자 통일 — AI 결과·문서 정규식 결과 모두에 적용
function cleanMenuText_(s) {
  return String(s || '')
    .replace(/[\u2460-\u2473\u24EA\u2776-\u277F]/g, '')
    .replace(/\(\s*\d+(?:\s*[.,·]\s*\d+)*\s*\)/g, '')
    .replace(/[◆◇★☆●○■□▲△※]/g, '')
    .replace(/\s*\|\s*/g, ' / ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// 보호자 개인정보(계좌번호·예금주) 제거. 친구 생일 이름은 birthdays 필드에서만 허용
function scrubSensitive_(text) {
  return String(text || '')
    .replace(/(은행|계좌|입금|예금주)([^\d\n]{0,12})[\d*][\d*\-\s]{7,}[\d*]/g, '$1$2[계좌 생략]')
    .replace(/(^|[^\d])\d{2,6}-[\d*]*\*[\d*]*-\d{3,}(?!\d)/g, '$1[계좌 생략]')
    .replace(/예금주\s*[:：]?\s*[가-힣]{2,4}/g, '예금주 생략');
}

/**
 * 파싱 결과 후처리 (AI 추출 → 코드 정리·검증)
 * - 개인정보 제거, 식단 정리·날짜 검증, 식단표 문서는 요약 없이 날짜·메뉴만
 * - 반환: 정리된 r (r._warnings에 검증 경고)
 */
function postProcessParse_(r, refDate) {
  if (!r) return r;
  const warnings = [];
  ['title', 'summary', 'uncertain'].forEach(k => { if (r[k]) r[k] = scrubSensitive_(r[k]); });
  (r.events || []).forEach(ev => ['what', 'items', 'note', 'dress'].forEach(k => { if (ev && ev[k]) ev[k] = scrubSensitive_(ev[k]); }));
  (r.deadlines || []).forEach(dl => { if (dl && dl.what) dl.what = scrubSensitive_(dl.what); });
  r.items = (r.items || []).map(scrubSensitive_);

  // 식단: 정리 + 날짜 검증 + 중복 날짜 병합(긴 쪽 채택)
  const byDate = {};
  (r.menus || []).forEach(m => {
    if (!m || !m.menu) return;
    const d = parseDate_(m.date);
    if (!d) { warnings.push('식단 날짜 형식 오류: ' + m.date); return; }
    const dow = d.getDay();
    if (dow === 0 || dow === 6) warnings.push('주말 식단: ' + formatDateWithDay_(m.date));
    const menu = cleanMenuText_(m.menu);
    if (!byDate[m.date] || menu.length > byDate[m.date].length) byDate[m.date] = menu;
  });
  r.menus = Object.keys(byDate).sort().map(d => ({ date: d, menu: byDate[d] }));

  // 생일: 같은 연령(동기) 반만, 날짜 검증
  r.birthdays = (r.birthdays || []).filter(b => {
    if (!b || !b.name || !parseDate_(b.date)) return false;
    if (b.class && SAME_AGE_CLASSES.indexOf(String(b.class).replace(/\s+/g, '')) < 0 && String(b.class).indexOf(MY_AGE_GROUP) < 0) return false;
    return true;
  }).map(b => ({ date: b.date, name: String(b.name).trim(), class: String(b.class || '').trim() }));

  // 활동 사진 메모: 날짜가 없거나 잘못되면 메일 수신일, 개인정보 제거, 80자·5건 제한
  r.activities = (r.activities || []).map(a => {
    if (!a || !a.what) return null;
    const what = scrubSensitive_(String(a.what)).replace(/\s+/g, ' ').trim().slice(0, 80);
    const date = parseDate_(a.date) ? a.date : (refDate || getSeoulDateStr_(0));
    // 미래 날짜는 수신일로 되돌림
    const safeDate = (refDate && date > refDate) ? refDate : date;
    const kind = String(a.kind || '').indexOf('유치원') >= 0 ? '유치원' : '일상';
    return what && !isPaymentText_(what) ? { date: safeDate, what: what, kind: kind } : null;
  }).filter(Boolean).slice(0, 5);
  // 활동 사진만 온 메일: 캘린더·통신문 요약에는 넣지 않고 활동 기록에만 남김
  r._activityOnly = r.activities.length > 0 && !(r.events || []).length && !(r.deadlines || []).length && !(r.menus || []).length;

  // 식단표 문서(식단만 있고 행사·기한 없음): 요약·준비물 없이 날짜와 메뉴만
  r._menuOnly = r.menus.length > 0 && !(r.events || []).length && !(r.deadlines || []).length;
  if (r._menuOnly) {
    r.summary = '';
    r.items = [];
    const months = Array.from(new Set(r.menus.map(m => +m.date.slice(5, 7))));
    r.title = months.map(mo => mo + '월').join('·') + ' 식단표';
  }
  r._warnings = warnings;
  if (warnings.length) r.uncertain = [r.uncertain, '식단 검증: ' + warnings.join(', ')].filter(Boolean).join(' / ');
  return r;
}

const DRESS_RULES_TEXT = [
  '- 월·수: 체육복',
  '- 화·목: 원복',
  '- 금: 자유복',
  '- 생일(생일잔치·' + CHILD_NAME + ' 본인 생일): 자유복. 친구 생일은 복장에 영향 없음',
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
  // [수정1] 정기 브리핑(05·21시)은 30분 주기 실행과 겹쳐도 최대 5분 대기, 그래도 실패하면 예외 → Apps Script 실패 알림 메일
  const waitMs = opts.isScheduled ? 300000 : 15000;
  if (!lock.tryLock(waitMs)) {
    if (opts.isScheduled) throw new Error('정기 브리핑: 스크립트 락 획득 실패 (' + (opts.reason || '') + ')');
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
    // [수정2] 날짜가 바뀌면 '오늘~+9일' 창이 밀려 해시가 바뀌므로, 그날 첫 실행은 기준값만 갱신하고 변경으로 보지 않음
    const todayStr = getSeoulDateStr_(0);
    const sameDay = cfg.props.getProperty(PROP_LAST_CAL_DAY) === todayStr;
    const calChanged = sameDay && prevCalHash !== null && calSnapshot.hash !== prevCalHash;
    if (!sameDay && prevCalHash !== null) {
      cfg.props.setProperty(PROP_LAST_CAL_HASH, calSnapshot.hash);
      cfg.props.setProperty(PROP_LAST_CAL_DAY, todayStr);
    }

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
    cfg.props.setProperty(PROP_LAST_CAL_DAY, getSeoulDateStr_(0));
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
  const managed = ['runOnce', 'pushKinderFeed', 'syncAndCheckUpdates', 'runMorningBriefing', 'runEveningBriefing', 'sendWeeklyUsageReport'];
  ScriptApp.getProjectTriggers()
    .filter(t => managed.indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('syncAndCheckUpdates').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('runMorningBriefing').timeBased().everyDays(1).atHour(5).inTimezone(TZ).create();
  ScriptApp.newTrigger('runEveningBriefing').timeBased().everyDays(1).atHour(21).inTimezone(TZ).create();
  ScriptApp.newTrigger('sendWeeklyUsageReport').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).inTimezone(TZ).create();
  console.log('트리거 설치 완료: syncAndCheckUpdates(30분), runMorningBriefing(05시), runEveningBriefing(21시), sendWeeklyUsageReport(월 08시)');
}

// ============================================================================
// 2. 메일 파싱 · 캘린더 등록 · Docs 기록
// ============================================================================

function processNewEmails_(cfg) {
  USAGE_TAG = '파싱';
  const done = getOrCreateLabel_(LABEL_DONE);
  const skip = getOrCreateLabel_(LABEL_SKIP);
  const doneIds = loadDoneIds_(cfg.props);
  const touchedDates = new Set();
  const titles = [];
  let relatedCount = 0;

  const parseLog = loadParseLog_(cfg.props);
  const cutoffMs = Date.now() - LOOKBACK_DAYS * 86400000;

  GmailApp.search(SEARCH_QUERY, 0, MAX_THREADS).forEach(thread => {
    let related = false;
    let threadFailed = false;
    let msgs = [];
    try { msgs = thread.getMessages(); } catch (e) { console.error('스레드 읽기 실패: ' + e); return; }

    msgs.forEach(msg => {
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
      // 제목 없는 나→나 메일은 한 스레드로 묶일 수 있음: 검색 창(7일)보다 오래된 메시지는 이미 처리된 것으로 보고 건너뜀
      if (msg.getDate().getTime() < cutoffMs) return;

      // 메시지 단위로 실패를 격리: 한 건이 실패해도 같은 스레드의 다른 메일은 처리
      try {
        const refDate = Utilities.formatDate(msg.getDate(), TZ, 'yyyy-MM-dd');
        const r = postProcessParse_(analyzeMessage_(msg, cfg.apiKey, cfg.parseModel), refDate);
        const rel = !!(r && r.is_related);
        if (rel) {
          related = true;
          relatedCount++;
          if ((r.activities || []).length) addActivities_(cfg.props, r.activities);
          if (r._activityOnly) {
            // 활동 사진: 격려 문장 참고용 기록만 (캘린더·통신문 요약 문서에는 넣지 않음)
            titles.push('활동 사진 ' + r.activities.length + '건');
          } else {
            titles.push(r.title || subj || KINDERGARTEN + ' 안내');
            const res = addCalendar_(r);
            res.dates.forEach(d => touchedDates.add(d));
            prependToDoc_(r, msg, cfg.props);
          }
        } else {
          addParseLog_(parseLog, msg, 'skip', r ? '' : '읽을 내용 없음');
        }
        removeParseLog_(parseLog, id, 'fail');
        doneIds[id] = { t: Date.now(), rel: rel };
        saveDoneIds_(cfg.props, doneIds);
      } catch (e) {
        threadFailed = true;
        addParseLog_(parseLog, msg, 'fail', String(e).slice(0, 120));
        console.error('메일 처리 실패: ' + describeMsg_(msg) + ' / ' + e);
      }
    });

    // 실패한 메일이 있으면 라벨을 달지 않아 다음 주기에 재시도 (7일 동안)
    if (!threadFailed) {
      thread.addLabel(done);
      if (!related) thread.addLabel(skip);
    }
  });
  saveParseLog_(cfg.props, parseLog);

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
  const photoDates = [];   // 첨부 사진의 촬영일(EXIF, 있으면) — 활동 날짜 판단에 사용
  const unreadable = [];   // 읽지 못한 첨부(HWP·DOCX·용량 초과 등) — 프롬프트와 '확인 필요'에 남김
  let size = 0;
  msg.getAttachments({ includeInlineImages: true }).forEach(a => {
    const type = a.getContentType();
    if (!ATTACH_TYPES.test(type)) { unreadable.push(a.getName() + ' (' + type + ')'); return; }
    const bytes = a.getBytes();
    if (size + bytes.length > MAX_BYTES) { unreadable.push(a.getName() + ' (용량 초과)'); return; }
    size += bytes.length;
    parts.push({ inline_data: { mime_type: type.toLowerCase(), data: Utilities.base64Encode(bytes) } });
    if (/^image\//i.test(type)) photoDates.push(exifDate_(bytes) || '없음');
  });
  // 제목 없이 본문만 복붙하는 경우가 많으므로 짧은 본문도 버리지 않음 (빈 메일만 제외)
  const bodyText = (msg.getPlainBody() || '').trim().slice(0, 20000);
  if (!parts.length && !bodyText && !unreadable.length) return null;

  const hasImage = parts.some(p => p.inline_data && /^image\//.test(p.inline_data.mime_type));
  // [수정4] 처리 시각이 아니라 메일 수신일을 기준 날짜로 사용 (newer_than:3d라 처리 지연 가능)
  const refDate = Utilities.formatDate(msg.getDate(), TZ, 'yyyy-MM-dd');
  const prompt = [
    '아래 메일 본문과 첨부(PDF·사진)를 읽고 JSON으로만 답하세요. 메일 수신일은 ' + refDate + '입니다.',
    '연도 없는 날짜는 수신일 기준 가장 가까운 날짜(당월 또는 가까운 미래)로 해석하세요.',
    '본문·첨부에 날짜가 명시된 항목만 events·deadlines에 넣으세요. "다음 주", "주말 지낸 이야기 대신"처럼 날짜를 추정해야 하는 항목은 events·deadlines에 넣지 말고 summary와 uncertain에 적으세요.',
    '자녀는 ' + KINDERGARTEN + ' ' + MY_AGE_GROUP + ' ' + MY_CLASS + '(' + CHILD_NAME + ')입니다.',
    'events에는 전체 대상 행사와 ' + MY_CLASS + ' 또는 ' + MY_AGE_GROUP + ' 전체가 대상인 행사만 넣고, 다른 반·다른 연령만 대상인 행사는 빼세요. 대상이 불분명하면 넣으세요.',
    '신입생 모집·입학 접수·재원생 동생 대상 안내 등 재원 가정과 무관한 일정과 기한은 events·deadlines에서 빼세요.',
    '[필수 추출 규칙]',
    '1. 식단표(menus)는 날짜별로 오전간식·점심·오후간식·후식·음료·과일을 절대 누락하지 말고 한 줄로 빠짐없이 적으세요. (예: "오전간식: 바나나, 우유 / 점심: 현미밥, 미역국, 닭갈비, 김치 / 오후간식: 감자전, 보리차")',
    '2. 행사(events)에 지정 복장(원복·체육복·동복체육복·자유복 등)이나 하원시간 변경·장소·담임선생님 확정 답변이 있으면 dress와 note에 빠짐없이 적으세요.',
    '3. 준비물(items)은 해당 행사에 필요한 물품을 빠짐없이 적으세요.',
    '4. 식단표 문서이면 summary는 빈 문자열로 두고, 친환경·원산지·공급업체·푸드브릿지·알레르기 안내는 어디에도 적지 마세요. menu에는 날짜별 메뉴명만 적고 알레르기 번호(①, (5.6) 등)와 기호(◆ 등)는 빼세요.',
    '5. 생일(birthdays): ' + CHILD_BIRTH_YEAR + '년생 반(' + SAME_AGE_CLASSES.join(', ') + ', ' + MY_AGE_GROUP + ') 원아의 생일만 날짜·이름·반으로 적으세요. 다른 연령 반 생일은 빼세요. 생일 원아 이름은 birthdays에만 적고 summary 등 다른 필드에는 적지 마세요.',
    '6. 계좌번호·카드번호·예금주 등 보호자 개인정보는 어떤 필드에도 적지 마세요(은행명까지만).',
    '7. 원문에 없는 해석(예: "이전 달 문구가 남은 것으로 보임", "오기")을 쓰지 마세요. 내용이 충돌하면 양쪽 원문을 그대로 uncertain에 적으세요.',
    '8. 아이의 활동·일상 사진이면 is_related는 true로 하고, 무엇을 하는 장면인지 activities에 한 줄씩 적으세요(최대 5개, 비슷한 장면은 하나로). 유치원 활동(체험·놀이·만들기)뿐 아니라 놀이터, 집에서 친구들과 놀기, 등원길·나들이 같은 유치원 밖 일상 사진도 포함합니다. 예: "숲에서 낙엽을 모아 던지며 놀았음", "단풍나무 아래 낙엽 길에서 브이 포즈를 했음".',
    '   - kind: 유치원 활동이면 "유치원", 유치원 밖 일상이면 "일상". 어디인지 불분명하면 "일상"으로 하고 장소를 지어내지 마세요.',
    '   - 문서 사진·화면 캡처·영수증·물건 사진처럼 아이의 활동 장면이 아닌 사진은 activities에 넣지 마세요(그런 사진만 있고 유치원과 무관하면 is_related는 false).',
    '   - 보호자가 보내는 활동 사진은 대부분 ' + CHILD_NAME + '이가 주인공입니다. 사진 가운데서 활동하는 아이를 ' + CHILD_NAME + '이로 보고 "' + CHILD_NAME + '이가 ~했음"처럼 적어도 됩니다. 여러 아이가 함께하는 장면이면 "친구들과 ~했음"으로 적으세요.',
    '   - 얼굴·외모·옷차림은 묘사하지 말고, 다른 아이의 이름은 적지 마세요. 사진에 보이지 않는 내용을 지어내지 마세요.',
    '   - 날짜 정하는 순서: (1) 본문에 날짜나 "어제·그저께·지난 토요일" 같은 표현이 있으면 수신일 기준으로 계산한 날짜 (2) 아래 [사진 촬영일]이 있으면 그 날짜 (3) kind가 "유치원"이고 아래 [최근 유치원 행사]의 한 행사와 활동 내용이 명확히 일치하면 그 행사 날짜 (4) 모두 아니면 빈 문자열. 억지로 맞추지 마세요.',
    '   - 참고: 촬영일이 "없음"인 사진은 유치원 앱(토모링)에서 받은 사진일 가능성이 높고(kind 유치원 쪽), 촬영일이 있는 사진은 보호자가 직접 찍은 사진일 가능성이 높습니다(kind 일상 쪽). 다만 사진 내용이 분명하면 내용을 우선하세요.',
    '   - [사진 촬영일 — 첨부 순서대로] ' + (photoDates.length ? photoDates.map((d, i) => (i + 1) + '번 ' + d).join(', ') : '(사진 없음)'),
    '   - [최근 유치원 행사] ' + (hasImage ? recentEventLinesForParse_(refDate) : '(해당 없음)'),
    '   - 활동 사진만 있는 메일이면 events·deadlines·menus는 비우세요.',
    '',
    '메일 제목: ' + (msg.getSubject() || '(제목 없음 — 본문·첨부만으로 판단)'),
    unreadable.length ? ('읽지 못한 첨부: ' + unreadable.join(', ') + ' → 내용을 추측하지 말고 uncertain에 "첨부를 읽지 못함: 파일명"을 적으세요.') : '',
    '메일 본문:\n' + (bodyText || '(없음)'),
    '',
    '응답 JSON 형식:',
    '{',
    '  "is_related": ' + KINDERGARTEN + '(또는 유치원 가정통신문·식단표·행사 안내·담임선생님 안내/답변)과 관련 있거나 아이의 활동·일상 사진이면 true, 명백히 무관하면 false. 제목이 없거나 판단이 애매하면 true,',
    '  "title": "문서 제목 또는 한 줄 설명",',
    '  "summary": "보호자가 알아야 할 핵심 3-5줄 (담임 답변·특이 복장·변경 사항 포함)",',
    '  "events": [{"date":"YYYY-MM-DD","time":"HH:MM 또는 빈 문자열","end_time":"HH:MM 또는 빈 문자열","what":"구체적 행사·장소 내용","dress":"지정 복장(명시된 경우만), 없으면 빈 문자열","items":"이 행사 준비물, 없으면 빈 문자열","note":"하원시간 변경·세부 안내, 없으면 빈 문자열"}],',
    '  "deadlines": [{"date":"YYYY-MM-DD","what":"제출·회신·납부 기한 내용(금액·방법 포함)"}],',
    '  "items": ["전체 준비물 목록"],',
    '  "menus": [{"date":"YYYY-MM-DD","menu":"오전간식·점심·후식·오후간식 메뉴명만 빠짐없이 (예: 점심: 현미밥, 미역국 / 후식: 사과 / 오후간식: 감자전)"}],',
    '  "birthdays": [{"date":"YYYY-MM-DD","name":"원아 이름","class":"반 이름(없으면 빈 문자열)"}],',
    '  "activities": [{"date":"YYYY-MM-DD 또는 빈 문자열","kind":"유치원 또는 일상","what":"사진에 보이는 활동 한 줄"}],',
    '  "uncertain": "읽기 어렵거나 날짜 해석이 불확실한 부분, 없으면 빈 문자열"',
    '}'
  ].join('\n');
  parts.push({ text: prompt });

  return callGeminiJsonWithMeta_(apiKey, model, parts);
}

function addCalendar_(r) {
  const cal = getTargetCalendar_();
  const baseDesc = [(r.title || ''), (r.summary || '')].filter(Boolean).join('\n') + '\n\n(자동 등록 — 날짜는 원문과 대조하세요)';
  const dates = new Set();

  // 돈 내는 항목은 캘린더 기록은 남기되 캘린더 알림(리마인더)은 끔
  const quietIfPayment = (ev, text) => {
    if (isPaymentText_(text)) { try { ev.removeAllReminders(); } catch (e) { /* 무시 */ } }
    return ev;
  };

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
    const created = s
      ? cal.createEvent(title, s, parseTime_(d, ev.end_time) || new Date(s.getTime() + 3600000), { description: evDesc })
      : cal.createAllDayEvent(title, d, { description: evDesc });
    quietIfPayment(created, title + ' ' + (ev.note || ''));
  });

  (r.deadlines || []).forEach(dl => {
    const d = parseDate_(dl.date); if (!d) return;
    dates.add(dl.date);
    const what = String(dl.what || '');
    const created = cal.createAllDayEvent('[통신문] 기한: ' + what, d, { description: baseDesc });
    quietIfPayment(created, what);
  });

  // 식단: 제목은 메뉴, 설명은 출처 제목만 (요약·안내문 없음)
  (r.menus || []).forEach(m => {
    const d = parseDate_(m.date); if (!d) return;
    dates.add(m.date);
    const ev = cal.createAllDayEvent('[식단] ' + m.menu, d, { description: (r.title || '식단표') + ' (자동 등록)' });
    try { ev.removeAllReminders(); } catch (e) { /* 무시 */ }
  });

  // 동기 생일: 같은 날짜·같은 이름이 이미 있으면 만들지 않음, 알림 없음
  (r.birthdays || []).forEach(b => {
    const d = parseDate_(b.date); if (!d) return;
    const title = LABEL_BIRTHDAY + ' ' + b.name + (b.class ? ' (' + b.class + ')' : '');
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const exists = cal.getEvents(d, next).some(ev => ev.getTitle().indexOf(LABEL_BIRTHDAY + ' ' + b.name) === 0);
    if (exists) return;
    const ev = cal.createAllDayEvent(title, d, { description: (r.title || '') + ' (자동 등록 — ' + CHILD_BIRTH_YEAR + '년생 동기 생일)' });
    try { ev.removeAllReminders(); } catch (e) { /* 무시 */ }
  });

  return { dates: Array.from(dates) };
}

/**
 * '통신문 요약' 문서 최상단에 날짜별 줄바꿈 목록(- YYYY-MM-DD(요일) | 내용) 포맷으로 기록
 * - 식단표 문서는 요약 없이 '식단:' 날짜·메뉴 목록만
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
    .map(m => ({ date: m.date, text: '- ' + formatDateWithDay_(m.date) + ' | ' + m.menu.trim() }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const birthdayRows = (r.birthdays || [])
    .map(b => ({ date: b.date, text: '- ' + formatDateWithDay_(b.date) + ' | ' + b.name + (b.class ? ' (' + b.class + ')' : '') }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const lines = [['H', stamp + ' · ' + (r.title || KINDERGARTEN + ' 안내')]];

  if (r._menuOnly) {
    lines.push(['P', '식단:']);
    menuRows.forEach(row => lines.push(['P', row.text]));
  } else {
    lines.push(['P', '요약: ' + (r.summary || '-')]);
    if (scheduleRows.length > 0) {
      lines.push(['P', '일정·기한:']);
      scheduleRows.forEach(row => lines.push(['P', row.text]));
    } else {
      lines.push(['P', '일정·기한: -']);
    }
    lines.push(['P', '준비물: ' + ((r.items && r.items.length) ? r.items.join(', ') : '-')]);
    if (birthdayRows.length > 0) {
      lines.push(['P', '생일:']);
      birthdayRows.forEach(row => lines.push(['P', row.text]));
      lines.push(['P', '']);   // 생일 목록과 식단 목록 구분 (식단 정규식 추출 오인 방지)
    }
    if (menuRows.length > 0) {
      lines.push(['P', '식단:']);
      menuRows.forEach(row => lines.push(['P', row.text]));
    } else {
      lines.push(['P', '식단: -']);
    }
  }

  if (r.uncertain) lines.push(['P', '확인 필요: ' + r.uncertain]);
  lines.push(['P', '원본 메일: ' + describeMsg_(msg)]);
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
  USAGE_TAG = '브리핑';
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

  // 격려 문장 기록: 시트 '다올 격려 문장 평가'에 문장별로 남김(좋음·나쁨 체크 → 다음 생성에 반영). 실패해도 브리핑엔 영향 없음
  logCheers_(cfg.props, todayBrief, generatedAt, cfg.briefingModel);
  delete todayBrief.cheer_context;
  delete tomorrowBrief.cheer_context;
  delete tomorrowBrief.cheer_unsure;

  const briefing = {
    generated_at: generatedAt,
    reason: opts.reason || '정기 브리핑',
    model: cfg.briefingModel,
    today: todayBrief,
    tomorrow: tomorrowBrief,
    combined_speech: buildCombinedSpeech_(todayBrief, tomorrowBrief)
  };

  // A안: 기존 entries 배열 유지 + briefing 객체 추가
  // [수정3] HA 장애 시에도 이메일 발송·스냅샷 저장은 진행 (30분마다 Gemini 재호출 반복 방지)
  try {
    pushHaWebhook_(calSnapshot.entries, briefing);
  } catch (e) {
    console.error('HA 전송 실패: ' + e);
    briefing.ha_error = String(e).slice(0, 200);
  }

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

  // 2) 해당 날짜의 캘린더 일정(수동 입력 포함, [식단]·[생일] 제외, 돈 내는 일정 제외)
  const birthdays = (calEventsForDay || []).filter(ev => ev.kind === 'birthday').map(ev => ev.title);
  const nonMenuCalEvents = (calEventsForDay || []).filter(ev =>
    ev.kind !== 'menu' && ev.kind !== 'birthday' && !isPaymentText_(ev.title));
  const calLines = nonMenuCalEvents.map(ev => {
    const timeTag = ev.time ? ev.time + (ev.endTime ? '~' + ev.endTime : '') : '종일';
    const kindTag = ev.kind === 'deadline' ? '[기한] ' : (ev.kind === 'manual' ? '[직접등록] ' : '');
    const descShort = ev.description ? ' | 메모: ' + ev.description.replace(/\s+/g, ' ').slice(0, 400) : '';
    return '- [' + timeTag + '] ' + kindTag + ev.title + descShort;
  });

  // 격려 문장(cheers)은 '오늘' 브리핑에서만 생성 → HA가 호출 때마다 무작위로 하나 읽음 (주말 포함)
  const wantCheers = dayLabel === '오늘';
  const isOwnBirthday = targetDateStr.slice(5) === CHILD_BIRTHDAY_MD;
  const friendNames = birthdays.map(t => String(t).replace(/\s*\(.*\)\s*$/, '').trim()).filter(n => n && n.indexOf(CHILD_NAME) < 0);
  // 놀러 가는 일정 등: '다올' 캘린더 일정 + (선택) 속성 CHEER_CALENDARS에 적은 캘린더의 그날 일정
  // 보호자 기본 캘린더 일정은 '평가 대상': 다올이와 함께하는 것이 명확할 때만 소재로 쓰고, 애매하면 쓰지 않고 메일로 알림
  const parentCal = wantCheers ? getCheerContextEvents_(targetDateStr) : { trusted: [], review: [] };
  const outingLines = wantCheers
    ? nonMenuCalEvents.map(ev => (ev.time ? ev.time + ' ' : '') + ev.title).concat(parentCal.trusted)
    : [];
  // 최근 3일(대상 날짜 포함)의 활동 사진 기록
  const recentActs = wantCheers ? recentActivityLines_(targetDateStr, ACTIVITY_CHEER_DAYS) : [];
  // 보호자가 구글 문서 '다올 격려 문장 지침'에 적은 지침과 그날 꼭 말할 것
  const guideDoc = wantCheers ? getCheerGuide_(targetDateStr) : { guide: '', must: [] };
  // 보호자가 시트 '다올 격려 문장 평가'에서 체크한 좋음·나쁨 문장
  const feedback = wantCheers ? getCheerFeedback_() : { good: [], bad: [] };
  const cheerSpecLines = [
    'cheers: 아침·등원 전에 들을 문장 5개. 오늘 하루와 오늘 일정을 응원하는 내용.',
    'cheers_pm: 오후·저녁(하원 뒤)에 들을 문장 5개. 오늘 하루를 돌아보며 칭찬하거나 어땠는지 묻고, 내일을 기대하게 하거나 푹 쉬라는 내용. "잘 다녀와"처럼 등원을 응원하는 표현은 쓰지 마세요.',
    'cheer_must: 아래 [오늘 꼭 말할 것]의 각 항목을 내용을 빼거나 바꾸지 않고 "' + CHILD_NAME + '아,"로 시작하는 다정한 반말 한 문장으로 옮기세요(항목당 1문장, 60자 이내). 항목이 없으면 빈 배열.',
    '브리핑을 들을 때마다 시간대에 맞는 묶음에서 무작위로 골라 읽고, cheer_must는 매번 반드시 읽습니다.'
  ];
  const cheerRuleLines = [
    '   - [보호자 지침 — 다른 규칙보다 우선해서 따르세요] ' + (guideDoc.guide || '(없음)'),
    '   - [오늘 꼭 말할 것] ' + (guideDoc.must.length ? guideDoc.must.map((x, i) => (i + 1) + ') ' + x).join(' / ') : '(없음)'),
    '   - [보호자가 좋다고 표시한 문장 — 이런 말투·길이·소재로 쓰되 같은 문장을 그대로 반복하지는 마세요] ' + (feedback.good.length ? feedback.good.join(' / ') : '(없음)'),
    '   - [보호자가 어색하다고 표시한 문장 — 이런 표현·내용·구성은 피하세요. 이유가 있으면 이유를 따르세요] ' + (feedback.bad.length ? feedback.bad.join(' / ') : '(없음)'),
    '   - 한국어 문장은 "' + CHILD_NAME + '아,"로 시작하는 다정한 반말 한 문장, 40자 이내, 특수기호 없이.',
    '   - 각 묶음(아침·오후)마다 1개는 여섯 살 아이가 알아들을 아주 쉬운 영어 한 문장으로 쓰세요. 반드시 "Hey Daol,"로 시작하고 9단어 이내 (예: Hey Daol, have a wonderful day!). 이름을 문장 맨 앞이나 맨 끝에 두지 마세요(음성이 이름을 뭉개 읽습니다).',
    '   - 그날 일정(현장학습·숲체험·발표·나들이·여행 등)과 그날의 의미를 자연스럽게 반영하되, 일정이 없으면 평범한 하루를 응원하세요. 한 묶음이 모두 같은 일정만 말하지 않게 섞으세요.',
    '   - 소재로 써도 좋은 것: 이번 달 프로젝트·주간 놀이 주제(예: 우주), 다가오는 유치원 일정(방학·소풍·발표·행사 등). [통신문 요약]에 실제로 나온 것만 쓰세요.',
    '   - 돈·복장·준비물·기한 얘기와 훈계·지시("말 잘 들어" 등)는 넣지 마세요. 일정에 없는 계획을 지어내지 마세요.',
    '   - 밝고 신나는 말투로, 문장은 느낌표로 끝내세요.',
    '   - ' + (isOwnBirthday ? '오늘은 ' + CHILD_NAME + '이 생일입니다. 모든 문장을 생일을 축하하는 문장으로 쓰세요.' : '오늘은 ' + CHILD_NAME + '이 생일이 아닙니다.') +
      (friendNames.length ? ' 오늘 생일인 친구: ' + friendNames.join(', ') + ' → 묶음마다 1개는 친구 생일을 함께 축하해 주자는 내용으로 쓰세요.' : ''),
    '   - [그날 일정 참고] ' + (outingLines.length ? outingLines.join(' / ') : '(등록된 일정 없음)'),
    '   - [최근 활동 — 보호자가 보낸 사진에서 뽑은 기록. "유치원"은 유치원 활동, "일상"은 유치원 밖(놀이터·집·나들이 등)] ' + (recentActs.length ? recentActs.join(' / ') : '(없음)'),
    '     · 있으면 묶음마다 1~2개는 그 활동을 떠올려 주는 문장으로 쓰세요(예: 어제 숲에서 낙엽 놀이 신났지?). ' + CHILD_NAME + '이가 직접 한 활동으로 말해도 됩니다. 기록에 없는 세부 내용은 덧붙이지 말고, "어제·그저께" 표현은 표시된 날짜 차이에 맞추세요.',
    '   - [보호자 개인 캘린더 — 평가 대상] ' + (parentCal.review.length ? parentCal.review.map(x => '"' + x + '"').join(', ') : '(없음)'),
    '     · 이 중 ' + CHILD_NAME + '이가 함께하는 것이 제목만으로 명확한 가족 나들이·여행·공연·모임만 소재로 쓰고, 쓴 제목을 cheer_used에 그대로 넣으세요.',
    '     · ' + CHILD_NAME + '이가 함께하는지 애매한 일정은 소재로 쓰지 말고 제목을 cheer_unsure에 그대로 넣으세요.',
    '     · 업무·진료·회의·개인 약속 등 명백히 무관한 일정은 쓰지도 말고 어디에도 넣지 마세요.'
  ];
  // 모델이 돌려준 제목이 실제 평가 대상 목록에 있는 것만 인정
  const pickReviewed = arr => toStringArray_(arr).filter(x => parentCal.review.indexOf(x) >= 0);

  // [수정8] 주말이고 해당 날짜 일정이 없으면 브리핑용 Gemini 호출 생략 (격려 문장만 짧게 따로 요청)
  if (isWeekend && nonMenuCalEvents.length === 0) {
    let weekendCheers = [];
    let weekendPm = [];
    let weekendMust = cleanMust_([], guideDoc.must);   // AI 실패 시에도 꼭 말할 것은 원문 그대로 전달
    let weekendUsed = [];
    let weekendUnsure = [];
    let cheerMeta = null;
    if (wantCheers) {
      try {
        cheerMeta = callGeminiJsonWithMeta_(apiKey, model, [{ text: [
          '오늘은 ' + formatDateWithDay_(targetDateStr) + ', 유치원에 가지 않는 주말입니다. JSON으로만 답하세요.',
          MY_AGE_GROUP + ' 아이 ' + CHILD_NAME + '이에게 직접 들려줄 따뜻한 격려·응원 문장을 서로 다른 내용으로 쓰세요.'
        ].concat(cheerSpecLines.map(x => '- ' + x)).concat(cheerRuleLines).concat([
          '응답 JSON 형식: {"cheers": ["' + CHILD_NAME + '아, ...", "...", "...", "...", "..."], "cheers_pm": ["...", "...", "...", "...", "..."], "cheer_must": ["..."], "cheer_used": ["소재로 쓴 개인 캘린더 일정 제목"], "cheer_unsure": ["애매해서 쓰지 않은 제목"]}',
          '',
          '[통신문 요약 최근 원문 일부 — 프로젝트 주제·다가오는 일정 참고용]',
          (docText || '').slice(0, 3000) || '(없음)'
        ]).join('\n') }]);
        weekendCheers = cleanCheers_((cheerMeta.data || {}).cheers);
        weekendPm = cleanCheers_((cheerMeta.data || {}).cheers_pm);
        weekendMust = cleanMust_((cheerMeta.data || {}).cheer_must, guideDoc.must);
        weekendUsed = pickReviewed((cheerMeta.data || {}).cheer_used);
        weekendUnsure = pickReviewed((cheerMeta.data || {}).cheer_unsure);
      } catch (e) {
        console.warn('주말 격려 문장 생성 실패(HA 기본 문장 사용): ' + e);
      }
    }
    return {
      cheers: weekendCheers,
      cheers_pm: weekendPm,
      cheer_must: weekendMust,
      cheer_context: outingLines.concat(weekendUsed).concat(recentActs.map(x => '[활동] ' + x)),
      cheer_unsure: weekendUnsure,
      date: targetDateStr,
      weekday: weekday,
      is_school_day: false,
      dress: baseDress,
      dress_reason: '주말 · 등록 일정 없음',
      events: [],
      deadlines: [],
      items: [],
      notes: [],
      menu: menu,
      birthdays: birthdays,
      speech: buildFullDaySpeech_(targetDateStr, dayLabel, '등원하지 않는 날입니다.', menu, false, birthdays),
      source: 'rule',
      latency_ms: cheerMeta ? cheerMeta.latencyMs : 0,
      usage: cheerMeta ? cheerMeta.usage : null
    };
  }

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
    '3. 현장학습·생일잔치·행사 시간·장소·하원시간 변경·개별 준비물·제출 기한을 누락 없이 반영하세요.',
    '4. 타 반(예: 즐거운반) 전용 일정이나 대상 날짜와 무관한 다른 날 일정은 제외하세요.',
    '5. speech_schedule은 시리(Siri)가 음성으로 읽을 자연스러운 한국어 2~4문장입니다. 특수기호(*, #, -, /, 괄호) 없이 등원 복장, 핵심 일정·준비물·기한만 간결하게 말하듯 작성하세요.',
    '   - 대상 날짜의 날짜·요일은 말하지 마세요(앞에 자동으로 붙습니다). 식단도 넣지 마세요.',
    '   - 대상 날짜는 반드시 "' + dayLabel + '"이라고 부르세요. 다른 날을 말할 때는 "11월 27일 금요일"처럼 날짜로 말하고, "오늘·내일·모레"로 부르지 마세요.',
    '6. 대상 날짜 이전에 이미 지난 일(지난 납부일·지난 행사 등)은 events·deadlines·notes·speech_schedule에 넣지 마세요.',
    '7. items에는 대상 날짜에 필요하다고 원문에서 날짜·행사로 특정되는 준비물만 넣으세요. 어느 날 준비물인지 원문에 특정되지 않으면 items·speech_schedule에 넣지 말고 notes에 "확인 필요: 물품명(근거 문서)"으로 적으세요.',
    '8. deadlines 각 항목은 "YYYY-MM-DD(요일)까지: 내용" 형식으로 시작하세요.',
    '9. 원문에 없는 해석(예: 문구가 오기라는 판단)을 사실처럼 쓰지 마세요.',
    '10. 교육비·납부·자동이체·출금·결제 등 돈 내는 항목은 events·deadlines·items·notes·speech_schedule 어디에도 넣지 마세요.',
    '11. 친구 생일은 언급하지 마세요(별도 시스템이 붙입니다). ' + CHILD_NAME + ' 본인 생일·생일잔치만 복장 판단에 반영하세요. (cheers는 예외)',
    ...(wantCheers ? [
      '12. ' + CHILD_NAME + '이에게 직접 들려줄 따뜻한 격려·응원 문장을 서로 다른 내용으로 쓰세요.',
      ...cheerSpecLines.map(x => '   - ' + x),
      ...cheerRuleLines
    ] : []),
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
    '  "speech_schedule": "시리 음성 브리핑용 일정·복장·준비물 요약 (식단 제외, 특수기호 제외)"' + (wantCheers ? ',' : ''),
    ...(wantCheers ? [
      '  "cheers": ["' + CHILD_NAME + '아, ...", "...", "...", "...", "..."],',
      '  "cheers_pm": ["' + CHILD_NAME + '아, ...", "...", "...", "...", "..."],',
      '  "cheer_must": ["' + CHILD_NAME + '아, ..."],',
      '  "cheer_used": ["소재로 쓴 개인 캘린더 일정 제목"],',
      '  "cheer_unsure": ["애매해서 쓰지 않은 개인 캘린더 일정 제목"]'
    ] : []),
    '}'
  ].join('\n');

  try {
    const res = callGeminiJsonWithMeta_(apiKey, model, [{ text: prompt }]);
    const d = res.data || {};
    const isSchoolDay = typeof d.is_school_day === 'boolean' ? d.is_school_day : !isWeekend;
    const dress = d.dress || baseDress;
    // 돈 내는 항목은 모델이 넣었더라도 코드에서 한 번 더 제거
    const notPay = arr => toStringArray_(arr).filter(x => !isPaymentText_(x));
    const speechSchedule = speakable_(dropPaymentSentences_(d.speech_schedule || ''));
    const speech = buildFullDaySpeech_(targetDateStr, dayLabel, speechSchedule, menu, isSchoolDay, birthdays);

    return {
      date: targetDateStr,
      weekday: weekday,
      is_school_day: isSchoolDay,
      dress: dress,
      dress_reason: d.dress_reason || (weekday + '요일 기본 규칙'),
      events: notPay(d.events),
      deadlines: notPay(d.deadlines),
      items: notPay(d.items),
      notes: notPay(d.notes),
      menu: menu,
      birthdays: birthdays,
      cheers: wantCheers ? cleanCheers_(d.cheers) : [],
      cheers_pm: wantCheers ? cleanCheers_(d.cheers_pm) : [],
      cheer_must: wantCheers ? cleanMust_(d.cheer_must, guideDoc.must) : [],
      cheer_context: outingLines.concat(pickReviewed(d.cheer_used)).concat(recentActs.map(x => '[활동] ' + x)),
      cheer_unsure: pickReviewed(d.cheer_unsure),
      speech: speech,
      source: 'gemini',
      latency_ms: res.latencyMs,
      usage: res.usage || null
    };
  } catch (e) {
    console.error('브리핑 Gemini 실패 (' + targetDateStr + ') — Fallback 전환: ' + e);
    return buildFallbackBriefing_(targetDateStr, dayLabel, weekday, baseDress, isWeekend, docText, nonMenuCalEvents, menu, e, birthdays);
  }
}

function buildFallbackBriefing_(targetDateStr, dayLabel, weekday, baseDress, isWeekend, docText, nonMenuCalEvents, menu, err, birthdays) {
  // 돈 내는 줄·생일 목록 줄은 제외 (생일은 캘린더 [생일]로 따로 붙음)
  const matchedLines = extractFallbackLines_(docText, targetDateStr).filter(line => !isPaymentText_(line));
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
    birthdays: birthdays || [],
    cheers: [],
    cheers_pm: [],
    cheer_must: dayLabel === '오늘' ? cleanMust_([], getCheerGuide_(targetDateStr).must) : [],
    speech: buildFullDaySpeech_(targetDateStr, dayLabel, speechSchedule, menu, !isWeekend, birthdays),
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
    if (/^(요약|일정·기한|준비물|생일|확인 필요|원본 메일|\d{4}-\d{2}-\d{2}\s*·)/.test(line)) {
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
    // 식단·생일 목록은 Fallback 일정으로 쓰지 않음 (식단은 따로, 생일은 캘린더 [생일]로 붙음)
    if (/^(식단|생일)\s*:?$/.test(line)) { inMenuSection = true; continue; }
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

function buildFullDaySpeech_(dateStr, dayLabel, speechSchedule, menu, isSchoolDay, birthdays) {
  const d = parseDate_(dateStr);
  const dateRead = (d.getMonth() + 1) + '월 ' + d.getDate() + '일 ' + getWeekdayKo_(dateStr) + '요일';
  const parts = [dayLabel + ' ' + dateRead + ' ' + CHILD_NAME + '이 브리핑입니다.'];
  if (speechSchedule) parts.push(speechSchedule);
  const bd = birthdaySentence_(dayLabel, birthdays);
  if (bd) parts.push(bd);
  if (menu) {
    parts.push('식단은 ' + cleanSpeechText_(menu) + '입니다.');
  } else if (isSchoolDay) {
    parts.push('등록된 식단은 없습니다.');
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 동기 생일 문장: '[생일] 송채아 (다정한반)' 일정 제목 목록 → "오늘은 송채아 친구 생일입니다."
 * 다올이 본인 이름이면 "오늘은 다올이 생일입니다."
 */
/**
 * 격려 문장 정리: 낭독용 정리, 돈 관련·너무 짧거나 긴 문장 제외, 중복 제거, 최대 8개
 */
/**
 * 격려 문장 참고용 보호자 캘린더 일정 (그날 하루)
 * - 대상: 기본 캘린더(계정 본인 캘린더) + 속성 CHEER_CALENDARS(쉼표 구분 이름)에 적은 캘린더. '다올' 캘린더는 호출부에서 따로 포함
 * - trusted: 제목에 '다올' 또는 '가족'이 있는 일정 → 평가 없이 소재로 사용
 * - review : 그 밖의 일정 → Gemini가 관련성을 평가 (명확하면 사용, 애매하면 미사용 + 브리핑 메일로 알림)
 * - 돈 관련 제목 제외, 계좌 패턴 제거, 최대 10건. 속성 CHEER_USE_MY_CALENDAR=false면 기본 캘린더를 읽지 않음
 */
function getCheerContextEvents_(dateStr) {
  const out = { trusted: [], review: [] };
  try {
    const props = PropertiesService.getScriptProperties();
    const d = parseDate_(dateStr);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const cals = [];
    if (String(props.getProperty('CHEER_USE_MY_CALENDAR') || 'true').toLowerCase() !== 'false') cals.push(CalendarApp.getDefaultCalendar());
    splitNames_(props.getProperty('CHEER_CALENDARS')).forEach(name => {
      if (name !== CAL_NAME) CalendarApp.getCalendarsByName(name).forEach(c => cals.push(c));
    });
    const seen = {};
    cals.forEach(cal => {
      cal.getEvents(d, next).forEach(ev => {
        const raw = (ev.getTitle() || '').trim();
        if (!raw || isPaymentText_(raw)) return;
        const title = scrubSensitive_(raw).slice(0, 60);
        if (seen[title]) return;
        seen[title] = true;
        if (out.trusted.length + out.review.length >= 10) return;
        if (title.indexOf(CHILD_NAME) >= 0 || title.indexOf('가족') >= 0) out.trusted.push(title);
        else out.review.push(title);
      });
    });
  } catch (e) {
    console.warn('격려 문장 참고 일정 읽기 실패(무시): ' + e);
  }
  return out;
}

function splitNames_(v) {
  return String(v || '').split(/[,，;]+/).map(x => x.trim()).filter(Boolean);
}

// 격려 문장 평가 시트: 문장 한 줄마다 좋음·나쁨 체크박스. 체크 결과를 다음 생성 프롬프트에 반영
// (이전의 구글 문서 '다올 격려 문장 로그'는 더 쓰지 않음 — 문서는 지우지 않고 그대로 둠)
const CHEER_SHEET_NAME    = '다올 격려 문장 평가';
const PROP_CHEER_SHEET_ID = 'CHEER_SHEET_ID';
const PROP_CHEER_LAST     = 'CHEER_LOG_LAST';
const CHEER_SHEET_HEADER  = ['날짜', '시각', '묶음', '문장', '좋음', '나쁨', '메모', '모델', '참고 일정'];
const CHEER_COL           = { date: 1, time: 2, kind: 3, text: 4, good: 5, bad: 6, memo: 7, model: 8, ctx: 9 };
const CHEER_FEEDBACK_ROWS = 400;   // 평가를 읽을 최근 행 수
const CHEER_FEEDBACK_MAX  = 8;     // 프롬프트에 넣을 좋음·나쁨 각각 최대 개수

/**
 * 평가 시트 열기 (없으면 만들고 머리글·틀 고정·열 너비 설정)
 */
function getCheerSheet_(props) {
  const p = props || PropertiesService.getScriptProperties();
  let ss = null;
  const id = p.getProperty(PROP_CHEER_SHEET_ID);
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create(CHEER_SHEET_NAME);
    p.setProperty(PROP_CHEER_SHEET_ID, ss.getId());
    const sh = ss.getSheets()[0];
    sh.setName('평가');
    sh.getRange(1, 1, 1, CHEER_SHEET_HEADER.length).setValues([CHEER_SHEET_HEADER]).setFontWeight('bold').setBackground('#f3f4f6');
    sh.setFrozenRows(1);
    sh.setColumnWidth(CHEER_COL.text, 360);
    sh.setColumnWidth(CHEER_COL.memo, 200);
    sh.setColumnWidth(CHEER_COL.ctx, 300);
    [CHEER_COL.date, CHEER_COL.time, CHEER_COL.kind, CHEER_COL.good, CHEER_COL.bad].forEach(c => sh.setColumnWidth(c, c === CHEER_COL.date ? 110 : 56));
    sh.getRange(1, CHEER_COL.ctx).setNote('좋음·나쁨을 클릭해 체크하세요. 이유는 메모 칸에 적으면 더 정확히 반영됩니다. 최신이 위.');
  }
  return ss.getSheets()[0];
}

/**
 * 격려 문장 기록: 문장 한 줄마다 시트 맨 위(머리글 아래)에 추가하고 좋음·나쁨 체크박스를 넣음
 * - 같은 내용이 연속으로 생성되면 중복 기록하지 않음
 */
function logCheers_(props, todayBrief, generatedAt, model) {
  try {
    const am = (todayBrief && todayBrief.cheers) || [];
    const pm = (todayBrief && todayBrief.cheers_pm) || [];
    const must = (todayBrief && todayBrief.cheer_must) || [];
    const cheers = must.map(x => ['꼭', x]).concat(am.map(x => ['아침', x])).concat(pm.map(x => ['오후', x]));
    if (!cheers.length) return;
    const sig = todayBrief.date + '|' + cheers.map(c => c.join(':')).join('|');
    if (props.getProperty(PROP_CHEER_LAST) === sig.slice(0, 400)) return;

    const sh = getCheerSheet_(props);
    const ctxParts = (todayBrief.cheer_context || []).slice();
    if ((todayBrief.birthdays || []).length) ctxParts.push('생일: ' + todayBrief.birthdays.join(', '));
    if ((todayBrief.cheer_unsure || []).length) ctxParts.push('애매해서 안 씀: ' + todayBrief.cheer_unsure.join(', '));
    const ctx = (ctxParts.join(' / ') || '(일정 없음)').slice(0, 1000);
    const dateCell = formatDateWithDay_(todayBrief.date);
    const timeCell = generatedAt.slice(11, 16);
    const modelCell = model + ' · ' + todayBrief.source;

    const rows = cheers.map((c, i) => [dateCell, timeCell, c[0], c[1], false, false, '', modelCell, i === 0 ? ctx : '']);
    const n = rows.length;
    sh.insertRowsBefore(2, n);
    const rng = sh.getRange(2, 1, n, CHEER_SHEET_HEADER.length);
    // 새 행이 위·아래 행 서식(머리글 굵기·체크박스 등)을 물려받지 않게 초기화
    rng.clearFormat().clearDataValidations();
    rng.setNumberFormat('@');   // 날짜·시각이 자동 변환되지 않게 글자로 저장
    rng.setValues(rows);
    sh.getRange(2, CHEER_COL.good, n, 2).setNumberFormat('General').insertCheckboxes();
    sh.getRange(2, CHEER_COL.ctx, n, 1).setWrap(false);
    // 같은 생성분 경계를 눈으로 구분 (첫 줄 위 굵은 선)
    sh.getRange(2, 1, 1, CHEER_SHEET_HEADER.length).setBorder(true, null, null, null, null, null, '#9ca3af', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    props.setProperty(PROP_CHEER_LAST, sig.slice(0, 400));
  } catch (e) {
    console.warn('격려 문장 기록 실패(무시): ' + e);
  }
}

/**
 * 보호자 평가 읽기: 최근 행에서 좋음·나쁨 체크한 문장(최신순, 각 최대 8개). 둘 다 체크한 줄은 무시
 * - 시트가 아직 없으면 만들지 않고 빈 결과
 */
function getCheerFeedback_(props) {
  const out = { good: [], bad: [] };
  try {
    const p = props || PropertiesService.getScriptProperties();
    const id = p.getProperty(PROP_CHEER_SHEET_ID);
    if (!id) return out;
    const sh = SpreadsheetApp.openById(id).getSheets()[0];
    const last = sh.getLastRow();
    if (last < 2) return out;
    const n = Math.min(last - 1, CHEER_FEEDBACK_ROWS);
    const seen = {};
    sh.getRange(2, 1, n, CHEER_COL.memo).getValues().forEach(r => {
      const text = String(r[CHEER_COL.text - 1] || '').trim();
      const good = r[CHEER_COL.good - 1] === true;
      const bad = r[CHEER_COL.bad - 1] === true;
      if (!text || good === bad || seen[text]) return;
      seen[text] = true;
      const memo = String(r[CHEER_COL.memo - 1] || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const line = '"' + text.slice(0, 70) + '"' + (memo ? ' (이유: ' + memo + ')' : '');
      const arr = good ? out.good : out.bad;
      if (arr.length < CHEER_FEEDBACK_MAX) arr.push(line);
    });
  } catch (e) {
    console.warn('격려 문장 평가 읽기 실패(무시): ' + e);
  }
  return out;
}

const CHEER_GUIDE_DOC_NAME = '다올 격려 문장 지침';
const PROP_CHEER_GUIDE_ID  = 'CHEER_GUIDE_DOC_ID';

/**
 * 구글 문서 '다올 격려 문장 지침' 읽기 (없으면 안내문과 함께 새로 만듦)
 * - '지침' 아래 줄들: AI에게 그대로 전달되는 평소 말투의 지침 (예: 더 짧게 / 사진 얘기는 하루 한 번만)
 * - '꼭 말할 것' 아래 줄들: "날짜: 내용" → 그 날짜 브리핑에서 매번 읽음. 날짜는 2026-11-27, 11/27, 11.27, 11월 27일, 매일
 * - 괄호로 시작하는 줄은 예시·설명이라 무시
 */
function getCheerGuide_(dateStr) {
  const out = { guide: '', must: [] };
  try {
    const props = PropertiesService.getScriptProperties();
    let doc = null;
    const id = props.getProperty(PROP_CHEER_GUIDE_ID);
    if (id) { try { doc = DocumentApp.openById(id); } catch (e) { doc = null; } }
    if (!doc) {
      doc = DocumentApp.create(CHEER_GUIDE_DOC_NAME);
      props.setProperty(PROP_CHEER_GUIDE_ID, doc.getId());
      const b = doc.getBody();
      b.appendParagraph('지침').setHeading(DocumentApp.ParagraphHeading.HEADING2);
      b.appendParagraph('(이 아래에 평소 말로 적으세요. 다음 브리핑부터 격려 문장에 반영됩니다. 예: 더 짧게 / 사진 얘기는 하루 한 번만 / 영어는 빼기)');
      b.appendParagraph('');
      b.appendParagraph('꼭 말할 것').setHeading(DocumentApp.ParagraphHeading.HEADING2);
      b.appendParagraph('(이 아래에 "날짜: 내용"으로 적으면 그날 브리핑에서 매번 읽습니다. 예: 11/27: 숲에서 물 많이 마시기 / 매일: 사랑해)');
      b.appendParagraph('');
      doc.saveAndClose();
      return out;
    }
    const target = parseDate_(dateStr);
    const guideLines = [];
    let section = '';
    doc.getBody().getText().split(/\r?\n/).forEach(raw => {
      const line = raw.replace(/^[#\s\-•*]+/, '').trim();
      if (!line) return;
      if (/^지침\s*:?$/.test(line)) { section = 'guide'; return; }
      if (/^꼭\s*말할\s*것\s*:?$/.test(line)) { section = 'must'; return; }
      if (/^[（(]/.test(line)) return;
      if (section === 'guide') { guideLines.push(line); return; }
      if (section === 'must') {
        const m = /^(매일|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s*[\/.]\s*\d{1,2}|\d{1,2}\s*월\s*\d{1,2}\s*일)\s*[:：]?\s*(.+)$/.exec(line);
        if (!m) return;
        let hit = m[1] === '매일';
        if (!hit) {
          const nums = m[1].match(/\d+/g).map(Number);
          const mo = nums.length === 3 ? nums[1] : nums[0];
          const da = nums.length === 3 ? nums[2] : nums[1];
          const yr = nums.length === 3 ? nums[0] : target.getFullYear();
          hit = yr === target.getFullYear() && mo === target.getMonth() + 1 && da === target.getDate();
        }
        if (hit && out.must.length < 3) out.must.push(m[2].trim().slice(0, 100));
      }
    });
    out.guide = guideLines.join(' / ').slice(0, 800);
  } catch (e) {
    console.warn('격려 문장 지침 문서 읽기 실패(무시): ' + e);
  }
  return out;
}

/**
 * 꼭 말할 것: AI가 옮긴 문장을 쓰되, 개수가 안 맞거나 비면 보호자가 적은 원문을 그대로 사용 (빠뜨리지 않는 것이 우선)
 */
function cleanMust_(aiArr, rawMust) {
  const raw = rawMust || [];
  if (!raw.length) return [];
  const ai = toStringArray_(aiArr).map(x => speakable_(x)).filter(x => x.length >= 4 && x.length <= 90);
  if (ai.length === raw.length) return ai;
  return raw.map(x => speakable_(x));
}

function cleanCheers_(arr) {
  const out = [];
  toStringArray_(arr).forEach(x => {
    const t = speakable_(x).replace(/[.。]\s*$/, '!');   // 밝게 읽히도록 끝 마침표는 느낌표로
    // 영어 문장은 'Hey Daol,'로 시작하게 정리 (영어 음성이 문장 첫 음절을 씹어 이름이 안 들림)
    const en = !/[가-힣]/.test(t);
    const t2 = en ? normalizeEnglishCheer_(t) : t;
    if (t2 !== t) { if (out.indexOf(t2) < 0 && t2.length <= 60) out.push(t2); return; }
    if (t.length < 6 || t.length > 60 || isPaymentText_(t)) return;
    if (out.indexOf(t) < 0) out.push(t);
  });
  return out.slice(0, 8);
}

function normalizeEnglishCheer_(t) {
  let x = String(t || '').trim();
  if (/^hey,?\s+daol\b/i.test(x)) return x.replace(/^hey,?\s+daol\b,?/i, 'Hey Daol,');
  if (/^daol\b,?/i.test(x)) return x.replace(/^daol\b,?\s*/i, 'Hey Daol, ');
  // 이름이 끝에 있으면 앞으로 옮김: "Have a great day, Daol!" → "Hey Daol, have a great day!"
  const m = /^(.*?),?\s+daol\s*([!.?]*)$/i.exec(x);
  if (m && m[1]) return 'Hey Daol, ' + m[1].charAt(0).toLowerCase() + m[1].slice(1) + (m[2] || '!');
  return 'Hey Daol, ' + x.charAt(0).toLowerCase() + x.slice(1);
}

function birthdaySentence_(dayLabel, birthdays) {
  const names = (birthdays || []).map(t => String(t || '').replace(/\s*\(.*\)\s*$/, '').trim()).filter(Boolean);
  if (!names.length) return '';
  const own = names.filter(n => n.indexOf(CHILD_NAME) >= 0);
  const friends = names.filter(n => n.indexOf(CHILD_NAME) < 0);
  const out = [];
  if (own.length) out.push(dayLabel + '은 ' + CHILD_NAME + '이 생일입니다.');
  if (friends.length) out.push(dayLabel + '은 ' + friends.join(', ') + ' 친구 생일입니다.');
  return out.join(' ');
}

function buildCombinedSpeech_(todayBrief, tomorrowBrief) {
  const parts = [todayBrief.speech];
  const tmw = [];
  // '내일 기한'은 마감일이 정확히 내일인 항목만 (다가오는 기한은 오늘 브리핑·메일에 이미 포함)
  const tmwDue = tomorrowBrief.deadlines.filter(x => isDueOn_(x, tomorrowBrief.date));
  if (tomorrowBrief.is_school_day) {
    tmw.push('내일 ' + tomorrowBrief.weekday + '요일 복장은 ' + speakable_(tomorrowBrief.dress) + '입니다.');
  }
  if (tomorrowBrief.events.length) {
    tmw.push('내일 일정은 ' + speakable_(tomorrowBrief.events.slice(0, 2).join(', ')) + '입니다.');
  }
  if (tmwDue.length) {
    tmw.push('내일이 마감인 항목은 ' + speakable_(tmwDue.slice(0, 2).map(stripLeadingDate_).join(', ')) + '입니다.');
  }
  if (tomorrowBrief.items.length) {
    tmw.push('내일 준비물은 ' + speakable_(tomorrowBrief.items.join(', ')) + '입니다.');
  }
  const tmwBd = birthdaySentence_('내일', tomorrowBrief.birthdays);
  if (tmwBd) tmw.push(tmwBd);
  if (tmw.length) parts.push('내일 예고입니다. ' + tmw.join(' '));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 기한 문자열 맨 앞 날짜(YYYY-MM-DD 또는 M월 D일)가 대상 날짜면 true. 앞에 '오늘(...)'·'내일(...)' 표기가 붙은 경우도 처리
 */
function isDueOn_(s, dateStr) {
  const d = parseDate_(dateStr);
  if (!d) return false;
  const t = String(s || '').replace(/^\s*(오늘|내일|모레)\s*\(?/, '').trim();
  const m1 = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m1) return m1[0] === dateStr;
  const m2 = /^(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(t);
  return !!m2 && +m2[1] === d.getMonth() + 1 && +m2[2] === d.getDate();
}

// '2026-11-27(금)까지: 급식 만족도 조사' → '급식 만족도 조사' (내일 마감 항목은 날짜를 다시 읽을 필요 없음)
function stripLeadingDate_(s) {
  return String(s || '')
    .replace(/^\s*(오늘|내일|모레)\s*\(?/, '')
    .replace(/^\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\s*월\s*\d{1,2}\s*일)(\([월화수목금토일]\))?\)?\s*(까지)?\s*[:：]?\s*/, '')
    .trim();
}

/**
 * 시리 낭독용 정리: 2026-11-27(금) → 11월 27일 금요일, 11월 27일(금) → 11월 27일 금요일, 「」『』·콜론 제거
 */
function speakable_(s) {
  return cleanSpeechText_(String(s || '')
    .replace(/\d{4}-(\d{2})-(\d{2})\(([월화수목금토일])\)/g, (_, mo, da, w) => (+mo) + '월 ' + (+da) + '일 ' + w + '요일')
    .replace(/\d{4}-(\d{2})-(\d{2})/g, (_, mo, da) => (+mo) + '월 ' + (+da) + '일')
    .replace(/(\d{1,2})월\s*(\d{1,2})일\s*\(([월화수목금토일])\)/g, '$1월 $2일 $3요일')
    .replace(/(^|[^\d])(\d{1,2}):(\d{2})(?!\d)/g, (_, pre, h, mi) => pre + (+h) + '시' + (+mi ? ' ' + (+mi) + '분' : ''))
    .replace(/[「」『』《》"“”]/g, '')
    .replace(/\s*[:：]\s*/g, ' '));
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
    } else if ((m = /^\[생일\]\s*(.*)$/.exec(title))) {
      kind = 'birthday';
      cleanTitle = m[1].trim();
      entries.push({ d: d, t: '', k: 'birthday', x: cleanTitle, i: '' });
    } else if ((m = /^\[통신문\]\s*기한:\s*(.*)$/.exec(title))) {
      kind = 'deadline';
      cleanTitle = m[1].trim();
      // 돈 내는 기한은 HA 알림 피드에서 제외 (캘린더에는 남음)
      if (!isPaymentText_(cleanTitle)) entries.push({ d: d, t: '', k: 'deadline', x: cleanTitle, i: '' });
    } else if ((m = /^\[통신문\]\s*(.*)$/.exec(title))) {
      kind = 'event';
      cleanTitle = m[1].trim();
      const im = /^준비물:\s*(.+)$/m.exec(desc);
      if (!isPaymentText_(cleanTitle)) entries.push({ d: d, t: t, k: 'event', x: cleanTitle, i: im ? im[1].trim() : '' });
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

function collectDocLinks_() {
  const props = PropertiesService.getScriptProperties();
  const url = id => id ? ('https://docs.google.com/document/d/' + id + '/edit') : '';
  return {
    guide: url(props.getProperty(PROP_CHEER_GUIDE_ID)),    // 다올 격려 문장 지침 (지침·꼭 말할 것 적는 곳)
    // log: 다올 격려 문장 평가 시트 (HA 대시보드 링크 키는 그대로 'log')
    log: props.getProperty(PROP_CHEER_SHEET_ID) ? ('https://docs.google.com/spreadsheets/d/' + props.getProperty(PROP_CHEER_SHEET_ID) + '/edit') : '',
    summary: url(props.getProperty(PROP_DOC_ID))           // 통신문 요약
  };
}

function pushHaWebhook_(entries, briefing) {
  const url = PropertiesService.getScriptProperties().getProperty('HA_WEBHOOK_URL');
  if (!url) {
    console.warn('스크립트 속성 HA_WEBHOOK_URL 없음 — HA 전송 생략');
    return;
  }
  // links: 관련 구글 문서 주소 (문서가 새로 만들어져 ID가 바뀌어도 HA 대시보드 링크가 따라 바뀜)
  const payload = { entries: entries, briefing: briefing, links: collectDocLinks_() };
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

  // 놓친 메일 확인용: 처리 실패(재시도 중) + 최근 24시간 '관련없음' 판정
  const issues = getParseIssues_(props);
  const docLinks = collectDocLinks_();
  const linkHtml = [['격려 문장 지침(지침·꼭 말할 것 적기)', docLinks.guide], ['격려 문장 평가(좋음·나쁨 체크)', docLinks.log], ['통신문 요약', docLinks.summary]]
    .filter(x => x[1]).map(x => '<a href="' + x[1] + '">' + escapeHtml_(x[0]) + '</a>').join(' · ');
  const issuePlain = [];
  const actLines = recentActivityLines_(briefing.today.date, ACTIVITY_CHEER_DAYS);
  if (actLines.length) issuePlain.push('📷 최근 ' + ACTIVITY_CHEER_DAYS + '일 활동 메모 (사진에서 읽은 내용, 격려 문장에 참고):\n  · ' + actLines.join('\n  · '));
  if (issues.failed.length) issuePlain.push('⚠ 처리 실패 메일 ' + issues.failed.length + '건 (자동 재시도 중, 7일 지나면 중단):\n  · ' + issues.failed.join('\n  · '));
  if (issues.skipped.length) issuePlain.push('ℹ 최근 24시간 \'관련없음\' 판정 메일 ' + issues.skipped.length + '건 (유치원 자료면 확인 필요):\n  · ' + issues.skipped.join('\n  · '));

  const plainBody = [
    '[' + KINDERGARTEN + ' ' + CHILD_NAME + ' 일일 브리핑]',
    '업데이트 시각: ' + briefing.generated_at,
    '업데이트 사유: ' + briefing.reason,
    '사용 모델: ' + briefing.model + ' (오늘: ' + briefing.today.source + ' / 내일: ' + briefing.tomorrow.source + ')',
    briefing.ha_error ? ('⚠ HA 전송 실패: ' + briefing.ha_error) : '',
    '',
    formatDayPlain_('오늘', briefing.today),
    '',
    formatDayPlain_('내일', briefing.tomorrow),
    issuePlain.length ? ('\n' + issuePlain.join('\n\n')) : '',
    '',
    '문서: 격려 문장 지침 ' + docLinks.guide + ' / 격려 문장 평가 ' + docLinks.log + ' / 통신문 요약 ' + docLinks.summary
  ].join('\n');

  const htmlBody = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:680px;line-height:1.6;color:#222;">',
    '<div style="background:#f4f6f9;border-left:4px solid #2563eb;padding:12px 16px;margin-bottom:16px;border-radius:4px;">',
    '<strong>' + escapeHtml_(KINDERGARTEN + ' ' + CHILD_NAME + ' 일일 브리핑') + '</strong><br/>',
    '<span style="font-size:13px;color:#555;">업데이트 시각: <b>' + escapeHtml_(briefing.generated_at) + '</b> · 사유: ' + escapeHtml_(briefing.reason) + '</span><br/>',
    '<span style="font-size:12px;color:#666;">모델: ' + escapeHtml_(briefing.model) + ' (오늘: ' + escapeHtml_(briefing.today.source) + ' / 내일: ' + escapeHtml_(briefing.tomorrow.source) + ')</span>',
    briefing.ha_error ? ('<br/><span style="font-size:12px;color:#dc2626;font-weight:bold;">HA 전송 실패: ' + escapeHtml_(briefing.ha_error) + '</span>') : '',
    '</div>',
    formatDayHtml_('오늘', briefing.today, '#2563eb'),
    formatDayHtml_('내일', briefing.tomorrow, '#0f766e'),
    issueHtml_('처리 실패 메일 (자동 재시도 중, 7일 지나면 중단)', issues.failed, '#dc2626'),
    issueHtml_('최근 24시간 \'관련없음\' 판정 메일 (유치원 자료면 확인 필요)', issues.skipped, '#b45309'),
    issueHtml_('📷 최근 ' + ACTIVITY_CHEER_DAYS + '일 활동 메모 (사진에서 읽은 내용, 격려 문장에 참고)', actLines, '#0f766e'),
    linkHtml ? ('<p style="font-size:13px;color:#555;">문서 바로가기: ' + linkHtml + '</p>') : '',
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

function issueHtml_(title, arr, color) {
  if (!arr || !arr.length) return '';
  return '<div style="border:1px solid ' + color + ';border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;">' +
    '<b style="color:' + color + ';">' + escapeHtml_(title) + ' · ' + arr.length + '건</b>' +
    '<ul style="margin:4px 0 0 18px;padding:0;">' + arr.map(x => '<li>' + escapeHtml_(x) + '</li>').join('') + '</ul></div>';
}

function formatDayPlain_(label, b) {
  return [
    '■ ' + label + ' (' + formatDateWithDay_(b.date) + ') [' + b.source + ']',
    '- 복장: ' + b.dress + (b.dress_reason ? ' (' + b.dress_reason + ')' : ''),
    '- 일정: ' + (b.events.length ? '\n  · ' + b.events.join('\n  · ') : '없음'),
    '- 기한: ' + (b.deadlines.length ? '\n  · ' + b.deadlines.join('\n  · ') : '없음'),
    '- 준비물: ' + (b.items.length ? b.items.join(', ') : '없음'),
    '- 식단: ' + (b.menu || '없음'),
    (b.birthdays || []).length ? ('- 동기 생일: ' + b.birthdays.join(', ')) : '',
    (b.cheer_must || []).length ? ('- 꼭 말할 것(매번 읽음):\n  · ' + b.cheer_must.join('\n  · ')) : '',
    (b.cheers || []).length ? ('- 격려 문장 · 아침(무작위):\n  · ' + b.cheers.join('\n  · ')) : '',
    (b.cheers_pm || []).length ? ('- 격려 문장 · 오후·저녁(무작위):\n  · ' + b.cheers_pm.join('\n  · ')) : '',
    (b.cheer_unsure || []).length ? ('- 격려 문장에 쓰지 않은 애매한 내 캘린더 일정: ' + b.cheer_unsure.join(' / ') +
      '\n  (' + CHILD_NAME + '이와 함께하는 일정이면 캘린더 제목에 "' + CHILD_NAME + '" 또는 "가족"을 넣어 주세요. 다음 브리핑부터 반영됩니다)') : '',
    b.notes.length ? ('- 메모: ' + b.notes.join(' / ')) : '',
    '- 음성 요약(메일용, 실제 시리 문장은 HA 템플릿이 만듦): ' + b.speech
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
    (b.birthdays || []).length ? ('<p style="margin:6px 0;"><b>🎂 동기 생일:</b> ' + escapeHtml_(b.birthdays.join(', ')) + '</p>') : '',
    (b.cheer_must || []).length ? ('<p style="margin:6px 0 2px 0;"><b>💛 꼭 말할 것 (매번 읽음):</b></p>' + listHtml(b.cheer_must)) : '',
    (b.cheers || []).length ? ('<p style="margin:6px 0 2px 0;"><b>💛 격려 문장 · 아침 (무작위):</b></p>' + listHtml(b.cheers)) : '',
    (b.cheers_pm || []).length ? ('<p style="margin:6px 0 2px 0;"><b>💛 격려 문장 · 오후·저녁 (무작위):</b></p>' + listHtml(b.cheers_pm)) : '',
    (b.cheer_unsure || []).length ? ('<p style="margin:6px 0;font-size:12px;color:#b45309;">격려 문장에 쓰지 않은 애매한 내 캘린더 일정: ' + escapeHtml_(b.cheer_unsure.join(' / ')) + ' (' + escapeHtml_(CHILD_NAME) + '이와 함께면 제목에 "' + escapeHtml_(CHILD_NAME) + '" 또는 "가족"을 넣어 주세요)</p>') : '',
    b.notes.length ? ('<p style="margin:6px 0;"><b>메모:</b> ' + escapeHtml_(b.notes.join(' / ')) + '</p>') : '',
    '<div style="background:#f9fafb;padding:8px 10px;border-radius:6px;margin-top:8px;font-size:13px;color:#444;">',
    '<b>음성 요약(메일용 · 실제 시리 문장은 HA 템플릿이 만듦):</b> ' + escapeHtml_(b.speech),
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
function listAvailableGeminiModels(quiet) {
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

  if (!quiet) models.forEach(m => console.log(m.id + ' | ' + m.displayName + ' | in:' + m.inputTokenLimit));
  return models;
}

/**
 * 모델별 브리핑 시뮬레이션 — 운영 경로와 동일하게 '오늘 + 내일' 2회 생성 후 combined_speech까지 비교
 * - 실제 '통신문 요약' + '다올' 캘린더를 읽기만 함 (HA 전송·문서·캘린더 변경 없음, 결과 이메일 1통 발송)
 * - ScriptProperties 'SIMULATION_MODELS'(쉼표 구분) 또는 인자 배열 사용, 미지정 시 자동 선택(최대 6개)
 * - Apps Script 실행 한도(6분) 대비: 누적 4분 30초를 넘기면 남은 모델은 건너뛰고 보고서에 표시
 */
function simulateBriefingModels(customModels) {
  USAGE_TAG = '시뮬레이션';
  const cfg = getConfig_();
  const candidates = resolveSimulationModels_(cfg, customModels);
  const todayStr = getSeoulDateStr_(0);
  const tomorrowStr = getSeoulDateStr_(1);
  const docText = getOrCreateDoc_(cfg.props).getBody().getText() || '';
  const calSnapshot = collectCalendarSnapshot_();
  const todayEvents = calSnapshot.byDate[todayStr] || [];
  const tomorrowEvents = calSnapshot.byDate[tomorrowStr] || [];
  const runStart = Date.now();
  const TIME_BUDGET_MS = 270000;

  const results = [];
  const skipped = [];
  candidates.forEach(model => {
    if (Date.now() - runStart > TIME_BUDGET_MS) { skipped.push(model); return; }
    const t = buildDayBriefing_(todayStr, '오늘', docText, todayEvents, cfg.apiKey, model);
    const m = buildDayBriefing_(tomorrowStr, '내일', docText, tomorrowEvents, cfg.apiKey, model);
    results.push({ model: model, today: t, tomorrow: m, combined: buildCombinedSpeech_(t, m) });
  });

  const reportLines = [
    '[브리핑 모델 시뮬레이션] 오늘 ' + formatDateWithDay_(todayStr) + ' + 내일 ' + formatDateWithDay_(tomorrowStr) + ' (운영 경로 동일)',
    '실행 시각: ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss'),
    '테스트 모델: ' + candidates.join(', '),
    'thinkingLevel: ' + (cfg.props.getProperty('GEMINI_THINKING_LEVEL') || '(모델 기본값)') +
      ' | temperature: ' + (cfg.props.getProperty('GEMINI_TEMPERATURE') || '0'),
    skipped.length ? ('시간 한도로 건너뜀: ' + skipped.join(', ')) : '',
    ''
  ];

  const dayBlock = (label, b) => [
    '  ■ ' + label + ' ' + formatDateWithDay_(b.date) + ' | ' + b.source + ' | ' + (b.latency_ms || 0) + 'ms | 토큰: ' + formatUsage_(b.usage),
    b.error ? ('  오류: ' + b.error) : '',
    '  복장: ' + b.dress + ' (' + b.dress_reason + ')',
    '  일정: ' + (b.events.length ? b.events.join(' / ') : '없음'),
    '  기한: ' + (b.deadlines.length ? b.deadlines.join(' / ') : '없음'),
    '  준비물: ' + (b.items.length ? b.items.join(', ') : '없음'),
    b.notes.length ? ('  메모: ' + b.notes.join(' / ')) : ''
  ].filter(Boolean);

  results.forEach(r => {
    reportLines.push('========================================');
    reportLines.push('모델: ' + r.model + ' | 합계 ' + ((r.today.latency_ms || 0) + (r.tomorrow.latency_ms || 0)) + 'ms');
    dayBlock('오늘', r.today).forEach(l => reportLines.push(l));
    dayBlock('내일', r.tomorrow).forEach(l => reportLines.push(l));
    reportLines.push('시리 최종 문구(combined_speech): ' + r.combined);
    reportLines.push('');
  });

  const report = reportLines.join('\n');
  console.log(report);
  sendSimulationEmail_(cfg.props, '브리핑 비교 (' + todayStr + '~' + tomorrowStr + ')', report);
  return results;
}

/**
 * [수정6] usageMetadata 요약: 입력 / 출력 / 추론(thinking) 토큰. 추론 토큰도 출력 단가로 과금됨
 */
function formatUsage_(u) {
  if (!u) return '-';
  return 'in:' + (u.promptTokenCount || 0) +
    ' / out:' + (u.candidatesTokenCount || 0) +
    ' / think:' + (u.thoughtsTokenCount || 0);
}

/**
 * 모델별 메일·첨부 파싱 시뮬레이션 (캘린더/Docs 변경 없음, 결과 이메일 1통)
 * - 제목 없이 복붙한 메일도 고를 수 있도록 제목이 아니라 날짜·본문 키워드·첨부 여부로 대상 선택
 * - opts: {
 *     date: 'YYYY-MM-DD'        받은 날짜 (해당 날짜 메일만)
 *     keyword: '숲체험'          본문·제목·첨부 파일명 중 하나에 포함 (첨부 PDF 내부 글자는 검색 안 됨)
 *     withAttachment: true      첨부(PDF·사진)가 있는 메일만
 *     count: 1                  비교할 메일 수 (최신순, 기본 1, 최대 3)
 *     query: 'Gmail 검색식'      직접 지정 시 사용 (기본: 처리 완료된 나→나 메일 최근 30개 스레드)
 *   }
 * - 아래 simParse* 함수를 편집기에서 바로 실행하면 됨
 */
function simulateParseModels(customModels, opts) {
  USAGE_TAG = '시뮬레이션';
  const o = opts || {};
  const cfg = getConfig_();
  const candidates = resolveSimulationModels_(cfg, customModels);
  const targets = findSimTargetMessages_(o);
  if (!targets.length) {
    throw new Error('조건에 맞는 메일이 없습니다: ' + JSON.stringify(o) + ' — 날짜·키워드를 바꾸거나 query를 지정하세요.');
  }

  const runStart = Date.now();
  const TIME_BUDGET_MS = 270000;
  const reportLines = [
    '[자료 파싱 모델 시뮬레이션]',
    '선택 조건: ' + (Object.keys(o).length ? JSON.stringify(o) : '(기본: 가장 최근 처리 메일)'),
    '테스트 모델: ' + candidates.join(', '),
    ''
  ];

  targets.forEach(msg => {
    const atts = msg.getAttachments({ includeInlineImages: true });
    reportLines.push('################################################');
    reportLines.push('대상 메일: ' + describeMsg_(msg));
    reportLines.push('첨부 ' + atts.length + '개' + (atts.length ? ': ' + atts.map(a => a.getName() + '(' + a.getContentType() + ', ' + (a.getSize() / 1048576).toFixed(1) + 'MB)').join(', ') : ''));
    reportLines.push('');

    candidates.forEach(model => {
      reportLines.push('========================================');
      if (Date.now() - runStart > TIME_BUDGET_MS) {
        reportLines.push('모델: ' + model + ' | 시간 한도로 건너뜀');
        return;
      }
      try {
        const res = analyzeMessageWithMeta_(msg, cfg.apiKey, model);
        if (!res) { reportLines.push('모델: ' + model + ' | 읽을 내용 없음(본문·첨부 없음)'); return; }
        // 운영과 동일한 후처리(개인정보 제거·식단 정리·식단표 요약 제거·동기 생일 필터)를 거친 결과를 표시
        const d = postProcessParse_(res.data || {}, Utilities.formatDate(msg.getDate(), TZ, 'yyyy-MM-dd')) || {};
        reportLines.push('모델: ' + model + ' | 성공 | 시간: ' + res.latencyMs + 'ms | 토큰: ' + formatUsage_(res.usage));
        reportLines.push('관련 여부: ' + (d.is_related ? '관련' : '관련없음'));
        reportLines.push('제목: ' + (d.title || '-'));
        reportLines.push('요약: ' + (d.summary || '-'));
        reportLines.push('일정(' + (d.events || []).length + '): ' + JSON.stringify(d.events || []));
        reportLines.push('기한(' + (d.deadlines || []).length + '): ' + JSON.stringify(d.deadlines || []));
        reportLines.push('준비물: ' + JSON.stringify(d.items || []));
        const menus = d.menus || [];
        reportLines.push('식단(' + menus.length + '):' + (menus.length ? '' : ' []'));
        menus.forEach(m => reportLines.push('  - ' + formatDateWithDay_(m.date) + ' | ' + m.menu));
        const acts = d.activities || [];
        reportLines.push('활동 메모(' + acts.length + '):' + (acts.length ? ' ' + acts.map(a => a.date + ' [' + a.kind + '] ' + a.what).join(' / ') : ' []') + (d._activityOnly ? '  ← 활동 사진 전용(캘린더·문서 미기록)' : ''));
        const bds = d.birthdays || [];
        reportLines.push('동기 생일(' + bds.length + '):' + (bds.length ? ' ' + bds.map(b => formatDateWithDay_(b.date) + ' ' + b.name + (b.class ? '(' + b.class + ')' : '')).join(', ') : ' []'));
        if (d.uncertain) reportLines.push('불확실: ' + d.uncertain);
      } catch (e) {
        reportLines.push('모델: ' + model + ' | 실패: ' + e);
      }
      reportLines.push('');
    });
  });

  const report = reportLines.join('\n');
  console.log(report);
  sendSimulationEmail_(cfg.props, '자료 파싱 비교', report);
}

/**
 * 시뮬레이션 대상 메시지 선택: 스레드 안의 '메시지' 단위로 필터 (제목 없는 메일은 한 스레드에 묶일 수 있음)
 */
function findSimTargetMessages_(o) {
  const q = o.query || ('from:me to:me label:' + LABEL_DONE + (o.withAttachment ? ' has:attachment' : '') +
    // Gmail 날짜 검색의 시간대 차이를 피하려고 앞뒤 하루씩 넓게 검색 후 아래에서 서울 기준 날짜로 정확히 거름
    (o.date ? ' after:' + addDaysStr_(o.date, -1).replace(/-/g, '/') + ' before:' + addDaysStr_(o.date, 2).replace(/-/g, '/') : ''));
  const kw = o.keyword ? String(o.keyword).replace(/\s+/g, '').toLowerCase() : '';
  const out = [];
  GmailApp.search(q, 0, 30).forEach(thread => {
    thread.getMessages().forEach(msg => {
      const subj = msg.getSubject() || '';
      if (subj.indexOf(BRIEFING_SUBJ_PFX) === 0 || subj.indexOf(SIM_SUBJ_PFX) === 0) return;
      if (o.date && Utilities.formatDate(msg.getDate(), TZ, 'yyyy-MM-dd') !== o.date) return;
      const atts = msg.getAttachments({ includeInlineImages: true });
      if (o.withAttachment && !atts.some(a => ATTACH_TYPES.test(a.getContentType()))) return;
      if (kw) {
        const hay = (subj + ' ' + (msg.getPlainBody() || '') + ' ' + atts.map(a => a.getName()).join(' '))
          .replace(/\s+/g, '').toLowerCase();
        if (hay.indexOf(kw) < 0) return;
      }
      out.push(msg);
    });
  });
  out.sort((a, b) => b.getDate().getTime() - a.getDate().getTime());
  return out.slice(0, Math.min(Math.max(o.count || 1, 1), 3));
}

function addDaysStr_(dateStr, n) {
  const d = parseDate_(dateStr);
  d.setDate(d.getDate() + n);
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

// ── 편집기에서 바로 실행하는 파싱 시뮬레이션 예시 (날짜·키워드만 바꿔 쓰면 됨) ──
function simParseLatest()           { simulateParseModels(null, {}); }
function simParseLatestAttachment() { simulateParseModels(null, { withAttachment: true }); }
function simParseByDate()           { simulateParseModels(null, { date: '2026-11-20', withAttachment: true, count: 2 }); }
function simParseByKeyword()        { simulateParseModels(null, { keyword: '숲체험' }); }

// ── PDF 파싱 검증용 (정답은 '통신문 요약' 문서의 해당 항목) ──
// 식단표 PDF (10/30): 식단 21일분 누락 여부 → 보고서의 '식단(N)' 숫자 확인
function simParseMenuPdf()   { simulateParseModels(null, { date: '2026-10-30', keyword: '54229150', withAttachment: true }); }
// 11월 4주 가정통신문·주간계획안 PDF (11/20): 다른 반 일정 제외, 날짜, 준비물, 담임 확정 내용
function simParseNoticePdf() { simulateParseModels(null, { date: '2026-11-20', withAttachment: true, count: 2 }); }
// 스캔 PDF 12월 교육비납부서 (11/21): 금액 479,000원, 결제일 2026-11-25
function simParseScanPdf()   { simulateParseModels(null, { date: '2026-11-21', keyword: 'hp scanner', withAttachment: true }); }

function resolveSimulationModels_(cfg, customModels) {
  // 시뮬레이션은 Gemini 4 계열만 비교 (인자·SIMULATION_MODELS에 다른 모델이 있어도 제외)
  const isG4 = id => /^gemini-4/i.test(String(id || ''));
  const only4 = list => {
    const out = [];
    list.forEach(id => { id = String(id || '').trim(); if (isG4(id) && out.indexOf(id) < 0) out.push(id); });
    const dropped = list.filter(id => id && !isG4(id));
    if (dropped.length) console.warn('Gemini 4가 아니어서 시뮬레이션에서 제외: ' + dropped.join(', '));
    return out;
  };

  if (Array.isArray(customModels) && customModels.length > 0) {
    const list = only4([].concat.apply([], customModels.map(splitModels_)));
    if (list.length > 0) return list;
  }
  const fromProp = cfg.props.getProperty('SIMULATION_MODELS');
  if (fromProp) {
    const list = only4(splitModels_(fromProp));
    if (list.length > 0) return list;
  }

  // 미지정 시 API에서 호출 가능한 Gemini 4 모델 자동 선택 (현재 설정 모델이 Gemini 4면 맨 앞)
  const picked = [];
  if (isG4(cfg.parseModel)) picked.push(cfg.parseModel);
  try {
    listAvailableGeminiModels(true).map(m => m.id).filter(isG4).forEach(id => { if (picked.indexOf(id) < 0) picked.push(id); });
  } catch (e) {
    console.warn('모델 자동 탐색 실패 — 기본 Gemini 4 목록 사용: ' + e);
  }
  if (picked.length <= 1) {
    ['gemini-4-hydrogen', 'gemini-4-argon', 'gemini-4-carbon', 'gemini-4-neon']
      .forEach(id => { if (picked.indexOf(id) < 0) picked.push(id); });
  }
  const finalList = picked.slice(0, 6);
  console.log('시뮬레이션 대상 모델(Gemini 4만): ' + finalList.join(', '));
  return finalList;
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
  const prevTag = USAGE_TAG;
  USAGE_TAG = '일정병합';
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

    // [수정10] 새 일정을 모두 만든 뒤에만 기존 일정 삭제 (중간 실패 시 일정 유실 방지)
    const created = [];
    try {
      entry.events.forEach(ev => {
        if (!ev || !ev.what) return;
        const isDeadline = ev.kind === 'deadline';
        const title = isDeadline ? ('[통신문] 기한: ' + ev.what) : ('[통신문] ' + ev.what);
        const descParts = [];
        if (!isDeadline && ev.items) descParts.push('준비물: ' + ev.items);
        if (ev.note) descParts.push(ev.note);
        descParts.push('(자동 통합 — 원문 대조 권장)');
        const evDesc = descParts.join('\n\n');

        if (isDeadline) {
          created.push(cal.createAllDayEvent(title, d, { description: evDesc }));
        } else {
          const s = parseTime_(d, ev.time);
          if (s) created.push(cal.createEvent(title, s, parseTime_(d, ev.end_time) || new Date(s.getTime() + 3600000), { description: evDesc }));
          else created.push(cal.createAllDayEvent(title, d, { description: evDesc }));
        }
      });
    } catch (e) {
      console.error('캘린더 통합 중 생성 실패 — 기존 일정 유지, 새로 만든 ' + created.length + '건 되돌림: ' + entry.date + ' / ' + e);
      created.forEach(ev => { try { ev.deleteEvent(); } catch (x) {} });
      return;
    }
    // 돈 내는 일정은 통합 후에도 캘린더 알림 없음
    created.forEach(ev => { if (isPaymentText_(ev.getTitle())) { try { ev.removeAllReminders(); } catch (x) {} } });
    if (created.length === 0) {
      console.warn('캘린더 통합 결과가 비어 기존 일정 유지: ' + entry.date);
      return;
    }
    oldEvs.forEach(ev => ev.deleteEvent());
    console.log('캘린더 통합 완료: ' + entry.date + ' (' + oldEvs.length + '건 → ' + created.length + '건)');
  });
  USAGE_TAG = prevTag;
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
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  const props = PropertiesService.getScriptProperties();

  // [수정6] 선택 설정: GEMINI_TEMPERATURE(미설정 시 0 유지), GEMINI_THINKING_LEVEL(예: low; 미설정 시 모델 기본값)
  const gc = { responseMimeType: 'application/json' };
  const tempProp = props.getProperty('GEMINI_TEMPERATURE');
  gc.temperature = (tempProp !== null && tempProp !== '' && !isNaN(Number(tempProp))) ? Number(tempProp) : 0;
  const thinkLvl = props.getProperty('GEMINI_THINKING_LEVEL');
  if (thinkLvl) gc.thinkingConfig = { thinkingLevel: thinkLvl };

  const buildOpts = genCfg => ({
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify({ contents: [{ parts: parts }], generationConfig: genCfg }),
    muteHttpExceptions: true
  });

  // [수정7] 429·5xx는 1회 재시도, thinkingLevel 미지원(400)이면 thinkingConfig 없이 1회 재시도
  const startMs = Date.now();
  let res = null;
  let code = 0;
  let curCfg = gc;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = UrlFetchApp.fetch(url, buildOpts(curCfg));
    code = res.getResponseCode();
    if (code === 200) break;
    if (code === 400 && curCfg.thinkingConfig && /thinking/i.test(res.getContentText())) {
      console.warn(model + ': thinkingLevel 미지원 — thinkingConfig 없이 재시도');
      curCfg = Object.assign({}, curCfg);
      delete curCfg.thinkingConfig;
      continue;
    }
    if ((code === 429 || code >= 500) && attempt < 2) {
      Utilities.sleep(3000 * (attempt + 1));
      continue;
    }
    break;
  }
  const latencyMs = Date.now() - startMs;

  if (code !== 200) {
    throw new Error('Gemini ' + code + ': ' + res.getContentText().slice(0, 300));
  }
  const body = JSON.parse(res.getContentText());
  const cand = body.candidates && body.candidates[0];
  if (!cand || !cand.content || !cand.content.parts) {
    const why = (cand && cand.finishReason) || (body.promptFeedback && body.promptFeedback.blockReason) || 'unknown';
    throw new Error('Gemini 빈 응답: ' + why);
  }
  const rawText = cand.content.parts.map(p => p.text || '').join('').trim();
  const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  recordUsage_(model, body.usageMetadata);
  return {
    data: JSON.parse(cleaned),
    latencyMs: latencyMs,
    usage: body.usageMetadata || null
  };
}

// ============================================================================
// 7. 토큰 사용량 기록 · 주간 보고 (매주 월 08시 메일)
// ============================================================================

let USAGE_TAG = '기타';               // 호출 용도: 파싱·브리핑·일정병합·시뮬레이션
const USAGE_KEY = 'USAGE_LOG';         // { 'YYYY-MM-DD': { '모델|용도': [호출, 입력, 출력, 추론] } }, 35일 보관
const USAGE_KEEP_DAYS = 35;

// 표준(유료) 단가, USD / 100만 토큰. 추론(thinking) 토큰은 출력 단가로 과금. to 생략 = 현재까지
// 출처: Google Gemini API 가격표·제3자 정리(2026-11-25 확인). 단가가 바뀌면 여기만 수정
const PRICE_TABLE = [
  { model: 'gemini-4-argon',  to:   '2026-11-30', in: 2, out: 10 },
  { model: 'gemini-4-argon',  from: '2026-12-01', in: 4, out: 20 },
  { model: 'gemini-4-carbon', to:   '2026-11-30', in: 2, out: 10 },
  { model: 'gemini-4-carbon', from: '2026-12-01', in: 4, out: 20 },
  { model: 'gemini-4-neon',                       in: 3, out: 15 }
  // gemini-4-hydrogen 등 미확인 모델은 '단가 미확인'으로 표시 (토큰은 집계)
];

function priceFor_(model, dateStr) {
  const p = PRICE_TABLE.find(x => x.model === model && (!x.from || dateStr >= x.from) && (!x.to || dateStr <= x.to));
  return p || null;
}

/**
 * Gemini 호출 1회 사용량 누적 (성공한 호출만). 실패해도 본 작업에 영향 없도록 예외 무시
 */
function recordUsage_(model, u) {
  if (!u) return;
  try {
    const props = PropertiesService.getScriptProperties();
    let log = {};
    try { log = JSON.parse(props.getProperty(USAGE_KEY) || '{}'); } catch (e) { log = {}; }
    const day = getSeoulDateStr_(0);
    const key = model + '|' + USAGE_TAG;
    if (!log[day]) log[day] = {};
    const a = log[day][key] || [0, 0, 0, 0];
    a[0] += 1;
    a[1] += u.promptTokenCount || 0;
    a[2] += u.candidatesTokenCount || 0;
    a[3] += u.thoughtsTokenCount || 0;
    log[day][key] = a;
    const cutoff = getSeoulDateStr_(-USAGE_KEEP_DAYS);
    Object.keys(log).forEach(d => { if (d < cutoff) delete log[d]; });
    props.setProperty(USAGE_KEY, JSON.stringify(log));
  } catch (e) {
    console.warn('사용량 기록 실패(무시): ' + e);
  }
}

/**
 * 기간(시작일~종료일 포함) 사용량 집계: 모델·용도별 행 + 합계, 비용은 날짜별 단가로 계산
 */
function summarizeUsage_(fromStr, toStr) {
  let log = {};
  try { log = JSON.parse(PropertiesService.getScriptProperties().getProperty(USAGE_KEY) || '{}'); } catch (e) { log = {}; }
  const rows = {};
  const total = { calls: 0, inT: 0, outT: 0, think: 0, cost: 0, unknown: false };
  Object.keys(log).sort().forEach(day => {
    if (day < fromStr || day > toStr) return;
    Object.keys(log[day]).forEach(key => {
      const [model, tag] = key.split('|');
      const a = log[day][key];
      const p = priceFor_(model, day);
      const cost = p ? (a[1] * p.in + (a[2] + a[3]) * p.out) / 1e6 : null;
      const r = rows[key] || (rows[key] = { model: model, tag: tag, calls: 0, inT: 0, outT: 0, think: 0, cost: 0, unknown: false });
      r.calls += a[0]; r.inT += a[1]; r.outT += a[2]; r.think += a[3];
      if (cost === null) r.unknown = true; else r.cost += cost;
      total.calls += a[0]; total.inT += a[1]; total.outT += a[2]; total.think += a[3];
      if (cost === null) total.unknown = true; else total.cost += cost;
    });
  });
  return { rows: Object.keys(rows).sort().map(k => rows[k]), total: total };
}

/**
 * 주간 사용량 보고 메일 (트리거: 매주 월 08시). 지난 7일(어제까지) + 그 전 7일 비교 + 30일 환산
 * 제목이 '[다올 브리핑'으로 시작하므로 메일 파싱 대상에서 자동 제외됨
 */
function sendWeeklyUsageReport() {
  const props = PropertiesService.getScriptProperties();
  const to = props.getProperty('BRIEFING_EMAIL') || Session.getEffectiveUser().getEmail();
  const end = getSeoulDateStr_(-1), start = getSeoulDateStr_(-7);
  const pEnd = getSeoulDateStr_(-8), pStart = getSeoulDateStr_(-14);
  const cur = summarizeUsage_(start, end);
  const prev = summarizeUsage_(pStart, pEnd);
  const usd = n => '$' + n.toFixed(3);
  const num = n => n.toLocaleString('en-US');
  const rate = Number(props.getProperty('USD_KRW') || 0);   // 선택: 원화 환산용 환율 (예: 1400)
  const won = n => rate ? ' (약 ' + Math.round(n * rate).toLocaleString('en-US') + '원)' : '';

  const lines = [
    '[' + KINDERGARTEN + ' ' + CHILD_NAME + ' 브리핑 — 주간 Gemini 사용량]',
    '기간: ' + formatDateWithDay_(start) + ' ~ ' + formatDateWithDay_(end),
    '운영 모델: ' + (singleModel_(props.getProperty('GEMINI_MODEL'), 'GEMINI_MODEL') || DEFAULT_MODEL),
    '',
    '■ 합계',
    '- 호출 ' + num(cur.total.calls) + '회 | 입력 ' + num(cur.total.inT) + ' / 출력 ' + num(cur.total.outT) + ' / 추론 ' + num(cur.total.think) + ' 토큰',
    '- 추정 비용 ' + usd(cur.total.cost) + won(cur.total.cost) + (cur.total.unknown ? ' + 단가 미확인 모델 사용분' : ''),
    '- 30일 환산 ' + usd(cur.total.cost * 30 / 7) + won(cur.total.cost * 30 / 7),
    '- 지난주 대비: ' + usd(prev.total.cost) + ' → ' + usd(cur.total.cost) + ' (호출 ' + prev.total.calls + ' → ' + cur.total.calls + '회)',
    '',
    '■ 모델·용도별'
  ];
  if (!cur.rows.length) lines.push('- 기록 없음');
  cur.rows.forEach(r => lines.push('- ' + r.model + ' · ' + r.tag + ': ' + r.calls + '회, 입력 ' + num(r.inT) +
    ' / 출력 ' + num(r.outT) + ' / 추론 ' + num(r.think) + ' → ' + (r.unknown ? '단가 미확인' : usd(r.cost) + won(r.cost))));
  lines.push('');
  lines.push('※ 비용은 유료(표준) 단가 기준 추정치입니다. 무료 등급·캐시 할인·Google 청구 금액과 다를 수 있으니 실제 청구는 AI Studio/Cloud 결제 화면에서 확인하세요.');
  lines.push('※ 단가표: 스크립트의 PRICE_TABLE (argon·carbon은 12/1부터 입력 $4·출력 $20 / 100만 토큰).');

  const body = lines.join('\n');
  console.log(body);
  if (to) {
    // 일별·모델·용도별 상세는 CSV 첨부 (브리핑 메일·시리에는 넣지 않음, 별도 메일)
    const csv = usageCsv_(start, end);
    MailApp.sendEmail({
      to: to,
      subject: BRIEFING_SUBJ_PFX + ' 사용량] ' + start + ' ~ ' + end + ' · ' + usd(cur.total.cost),
      body: body,
      attachments: [Utilities.newBlob('\uFEFF' + csv, 'text/csv', 'gemini_usage_' + start + '_' + end + '.csv')]
    });
  }
}

/**
 * 첨부용 CSV: 날짜, 모델, 용도, 호출, 입력, 출력, 추론, 추정비용(USD). 엑셀 한글 깨짐 방지로 BOM 포함
 */
function usageCsv_(fromStr, toStr) {
  let log = {};
  try { log = JSON.parse(PropertiesService.getScriptProperties().getProperty(USAGE_KEY) || '{}'); } catch (e) { log = {}; }
  const out = ['날짜,모델,용도,호출,입력토큰,출력토큰,추론토큰,추정비용USD'];
  Object.keys(log).sort().forEach(day => {
    if (day < fromStr || day > toStr) return;
    Object.keys(log[day]).sort().forEach(key => {
      const [model, tag] = key.split('|');
      const a = log[day][key];
      const p = priceFor_(model, day);
      const cost = p ? ((a[1] * p.in + (a[2] + a[3]) * p.out) / 1e6).toFixed(4) : '단가미확인';
      out.push([day, model, tag, a[0], a[1], a[2], a[3], cost].join(','));
    });
  });
  return out.join('\n');
}

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('스크립트 속성 GEMINI_API_KEY가 없습니다.');
  // 운영 모델 속성은 모델 1개만 허용. 실수로 여러 개(쉼표 구분)를 넣으면 첫 번째만 쓰고 경고
  const parseModel = singleModel_(props.getProperty('GEMINI_MODEL'), 'GEMINI_MODEL') || DEFAULT_MODEL;
  const briefingModel = singleModel_(props.getProperty('GEMINI_BRIEFING_MODEL'), 'GEMINI_BRIEFING_MODEL') || parseModel;
  return { props: props, apiKey: apiKey, parseModel: parseModel, briefingModel: briefingModel };
}

function splitModels_(v) {
  return String(v || '').split(/[,，;\s]+/).map(x => x.trim()).filter(Boolean);
}

function singleModel_(v, propName) {
  const list = splitModels_(v);
  if (list.length > 1) {
    console.warn('스크립트 속성 ' + propName + '에 모델이 여러 개 들어 있어 첫 번째(' + list[0] + ')만 사용합니다. ' +
      '비교용 모델 목록은 SIMULATION_MODELS 속성에 넣으세요.');
  }
  return list[0] || '';
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

/**
 * 메일 식별용 짧은 설명: 제목이 없으면 본문 앞부분·첨부 이름으로 대신함
 */
function describeMsg_(msg) {
  const when = Utilities.formatDate(msg.getDate(), TZ, 'MM-dd HH:mm');
  const subj = (msg.getSubject() || '').trim();
  if (subj) return when + ' · ' + subj.slice(0, 40);
  // 'iPhone에서 보냄' 같은 서명만 있는 본문은 식별에 쓸모없으므로 지우고, 비면 첨부 파일명으로 표시
  const body = (msg.getPlainBody() || '')
    .replace(/^\s*(나의\s*)?(iPhone|iPad|Galaxy|갤럭시|Android)[^\n]*(보냄|보낸|Sent)[^\n]*$/gim, '')
    .replace(/^\s*Sent from my [^\n]*$/gim, '')
    .replace(/\s+/g, ' ').trim();
  const names = msg.getAttachments({ includeInlineImages: true }).map(a => a.getName()).join(', ');
  if (body) return when + ' · (제목 없음) ' + body.slice(0, 40) + (names ? ' [첨부: ' + names.slice(0, 40) + ']' : '');
  return when + ' · (제목·본문 없음) ' + (names ? '첨부: ' + names : '첨부 없음').slice(0, 60);
}

// 관련없음 판정(skip)·처리 실패(fail) 기록: 최근 7일, 최대 30건. 브리핑 메일에 표시해 놓친 메일을 사람이 확인
// ── 활동 사진 기록 (격려 문장 참고용). 사진은 저장하지 않고 글 메모만 보관 ──
const ACTIVITY_KEY        = 'ACTIVITY_LOG';   // [{d:'YYYY-MM-DD', w:'활동 한 줄', t:기록시각}]
const ACTIVITY_KEEP_DAYS  = 14;
const ACTIVITY_CHEER_DAYS = 3;                // 격려 문장·브리핑 메일에 쓰는 최근 일수

/**
 * 활동 사진의 날짜를 맞추기 위한 참고: 수신일 기준 지난 14일~당일의 '다올' 캘린더 [통신문] 행사(기한·돈 관련 제외)
 */
function recentEventLinesForParse_(refDateStr) {
  try {
    const ref = parseDate_(refDateStr);
    const from = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 14);
    const to = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1);
    const seen = {};
    const out = [];
    getTargetCalendar_().getEvents(from, to).forEach(ev => {
      const m = /^\[통신문\]\s*(?!기한:)(.*)$/.exec(ev.getTitle() || '');
      if (!m || isPaymentText_(m[1])) return;
      const start = ev.isAllDayEvent() ? ev.getAllDayStartDate() : ev.getStartTime();
      const line = Utilities.formatDate(start, TZ, 'yyyy-MM-dd') + ' ' + m[1].trim().slice(0, 60);
      if (!seen[line]) { seen[line] = true; out.push(line); }
    });
    return out.length ? out.slice(-20).join(' / ') : '(없음)';
  } catch (e) {
    return '(없음)';
  }
}

/**
 * 수동 실행용: 활동 사진 기록을 모두 지움 (날짜가 잘못 기록됐을 때 지우고 사진을 다시 보내면 새 규칙으로 기록됨)
 */
function clearActivityLog() {
  PropertiesService.getScriptProperties().deleteProperty(ACTIVITY_KEY);
  console.log('활동 사진 기록을 지웠습니다.');
}

/**
 * 사진 바이트 앞부분에서 EXIF 촬영일(YYYY:MM:DD HH:MM:SS)을 찾아 'YYYY-MM-DD'로 반환. 없으면 ''.
 * - 아이폰에서 직접 보낸 사진은 대개 남아 있고, 유치원 앱에서 받은 사진은 지워진 경우가 많음
 * - 여러 개면 가장 이른 날짜(촬영 시각)를 사용. 2020년 이전·미래 날짜는 무시
 */
function exifDate_(bytes) {
  try {
    const n = Math.min(bytes.length, 200000);
    let str = '';
    for (let i = 0; i < n; i += 8192) {
      str += String.fromCharCode.apply(null, bytes.slice(i, Math.min(i + 8192, n)).map(b => b & 0xff));
    }
    const today = getSeoulDateStr_(0);
    const re = /(20\d{2}):(\d{2}):(\d{2}) \d{2}:\d{2}:\d{2}/g;
    let m, best = '';
    while ((m = re.exec(str)) !== null) {
      const d = m[1] + '-' + m[2] + '-' + m[3];
      if (!parseDate_(d) || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) continue;
      if (d < '2020-01-01' || d > today) continue;
      if (!best || d < best) best = d;
    }
    return best;
  } catch (e) {
    return '';
  }
}

function loadActivities_(props) {
  let arr = [];
  try { arr = JSON.parse((props || PropertiesService.getScriptProperties()).getProperty(ACTIVITY_KEY) || '[]'); } catch (e) { arr = []; }
  const cutoff = getSeoulDateStr_(-ACTIVITY_KEEP_DAYS);
  return arr.filter(x => x && x.d && x.w && x.d >= cutoff);
}

function addActivities_(props, activities) {
  try {
    const arr = loadActivities_(props);
    (activities || []).forEach(a => {
      if (!arr.some(x => x.d === a.date && x.w === a.what)) arr.push({ d: a.date, w: a.what, k: a.kind || '일상', t: Date.now() });
    });
    arr.sort((a, b) => a.d.localeCompare(b.d) || a.t - b.t);
    let out = arr.slice(-40);
    let json = JSON.stringify(out);
    while (json.length > 8000 && out.length > 1) { out = out.slice(1); json = JSON.stringify(out); }
    props.setProperty(ACTIVITY_KEY, json);
  } catch (e) {
    console.warn('활동 기록 저장 실패(무시): ' + e);
  }
}

/**
 * 대상 날짜 기준 최근 days일(대상 날짜 포함, 미래 제외)의 활동을 "어제(11월 24일): 내용" 형태로 반환
 */
function recentActivityLines_(targetDateStr, days) {
  const out = [];
  try {
    const target = parseDate_(targetDateStr);
    loadActivities_().forEach(x => {
      const d = parseDate_(x.d);
      if (!d) return;
      const diff = Math.round((target - d) / 86400000);
      if (diff < 0 || diff >= days) return;
      const rel = diff === 0 ? '오늘' : (diff === 1 ? '어제' : (diff === 2 ? '그저께' : diff + '일 전'));
      out.push(rel + '(' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일, ' + (x.k || '일상') + '): ' + x.w);
    });
  } catch (e) {
    console.warn('활동 기록 읽기 실패(무시): ' + e);
  }
  return out.slice(-8);
}

function loadParseLog_(props) {
  let arr = [];
  try { arr = JSON.parse(props.getProperty(PARSE_LOG_KEY) || '[]'); } catch (e) { arr = []; }
  const cutoff = Date.now() - LOOKBACK_DAYS * 86400000;
  return arr.filter(x => x && x.t >= cutoff);
}

function saveParseLog_(props, arr) {
  let out = arr.slice(-30);
  let json = JSON.stringify(out);
  while (json.length > 8000 && out.length > 1) { out = out.slice(1); json = JSON.stringify(out); }
  props.setProperty(PARSE_LOG_KEY, json);
}

function addParseLog_(arr, msg, status, err) {
  const id = msg.getId();
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i].id === id) arr.splice(i, 1);
  arr.push({ id: id, t: Date.now(), st: status, d: describeMsg_(msg), e: err || '' });
}

function removeParseLog_(arr, id, status) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i].id === id && arr[i].st === status) arr.splice(i, 1);
}

/**
 * 브리핑 메일용: 처리 실패(미해결 전부) + 최근 24시간 관련없음 판정 메일 목록
 */
function getParseIssues_(props) {
  const log = loadParseLog_(props);
  const dayAgo = Date.now() - 86400000;
  return {
    failed: log.filter(x => x.st === 'fail').map(x => x.d + (x.e ? ' — ' + x.e : '')),
    skipped: log.filter(x => x.st === 'skip' && x.t >= dayAgo).map(x => x.d + (x.e ? ' — ' + x.e : ''))
  };
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
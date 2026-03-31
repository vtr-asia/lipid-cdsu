/**
 * cds-core.js — 台灣血脂 CDS 共用核心模組
 * 2025 台灣血脂管理專家共識建議
 * ─────────────────────────────────────────
 * 涵蓋：風險設定、CDS 邏輯、FHIR 查詢、病人渲染、衛教內容
 */

// ═══════════════════════════════════════════
// §1  風險分層設定表
// ═══════════════════════════════════════════
const RISK_CONFIG = {
  low:          { icon:"🟢", label:"一般風險",   target:130, desc:"無重大心血管疾病、無糖尿病、無慢性腎病",   icdHints:[] },
  high:         { icon:"🟡", label:"高風險",     target:100, desc:"糖尿病病史（DM）",                      icdHints:["E11","E10","E13"] },
  veryhigh_mi:  { icon:"🔴", label:"非常高風險", target:70,  desc:"曾患急性心肌梗塞（History of MI）",      icdHints:["I21","I22"] },
  veryhigh_stroke:{ icon:"🔴",label:"非常高風險",target:70,  desc:"缺血性腦中風或周邊動脈疾病（PAD）",       icdHints:["I63","I65","I73"] },
  veryhigh_ckd: { icon:"🔴", label:"非常高風險", target:70,  desc:"慢性腎病第五期（CKD Stage 5 / 洗腎）",   icdHints:["N18.5","N18.6"] },
  extreme:      { icon:"⚫", label:"極高風險",   target:55,  desc:"ASCVD 復發（已使用最大耐受劑量 Statin）", icdHints:["I25","Z82.49"] }
};

// ICD-10 → riskKey 映射（優先順序：最嚴重者優先）
const ICD_RISK_MAP = [
  { prefix:["I21","I22"],          key:"extreme"         }, // 若有 Statin 再提升 → extreme；初判先放 veryhigh_mi
  { prefix:["I25","Z82.49"],       key:"extreme"         },
  { prefix:["I21","I22"],          key:"veryhigh_mi"     },
  { prefix:["I63","I65","I73"],    key:"veryhigh_stroke" },
  { prefix:["N18.5","N18.6"],      key:"veryhigh_ckd"    },
  { prefix:["E11","E10","E13"],    key:"high"            }
];

// Statin 藥品名稱關鍵字（用於判斷是否已用 statin）
const STATIN_KEYWORDS = ["statin","atorvastatin","rosuvastatin","simvastatin","pitavastatin","fluvastatin","lovastatin","pravastatin","他汀","立普妥","冠脂妥","素果"];
const EZETIMIBE_KEYWORDS = ["ezetimibe","益糾脂","vytorin","zetia"];
const PCSK9_KEYWORDS = ["evolocumab","alirocumab","repatha","praluent","pcsk9"];

// ═══════════════════════════════════════════
// §2  LOINC 代碼清單
// ═══════════════════════════════════════════
const LOINC = {
  LDL:    ["http://loinc.org|13457-7", "http://loinc.org|18262-6", "http://loinc.org|2089-1"],
  TC:     ["http://loinc.org|2093-3"],
  HDL:    ["http://loinc.org|2085-9"],
  TG:     ["http://loinc.org|2571-8"],
  BP:     ["http://loinc.org|85354-9"],
  BP_SBP: "http://loinc.org|8480-6",
  BP_DBP: "http://loinc.org|8462-4",
  GLUCOSE:["http://loinc.org|2339-0","http://loinc.org|15074-8"],
  WEIGHT: ["http://loinc.org|29463-7"],
  HBA1C:  ["http://loinc.org|4548-4"],
  CREATININE:["http://loinc.org|2160-0"],
};

// ═══════════════════════════════════════════
// §3  工具函式
// ═══════════════════════════════════════════

/** 血脂數值格式化：整數或一位小數（臨床習慣） */
function fmtLipid(val) {
  if (val == null) return "—";
  const n = parseFloat(val);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** 計算年齡 */
function calcAge(birthDate) {
  if (!birthDate) return null;
  return Math.floor((Date.now() - new Date(birthDate)) / (365.25 * 24 * 3600 * 1000));
}

/** 從 Observation Bundle 取第一筆數值 */
function firstObsValue(bundle) {
  const entry = bundle?.entry?.[0]?.resource;
  if (!entry) return { value: null, date: null, unit: null };
  return {
    value: entry.valueQuantity?.value ?? null,
    date:  (entry.effectiveDateTime || entry.effectivePeriod?.start || "").slice(0, 10),
    unit:  entry.valueQuantity?.unit || entry.valueQuantity?.code || ""
  };
}

/** 從 Observation Bundle 取所有數值（趨勢用）*/
function allObsValues(bundle) {
  if (!bundle?.entry) return [];
  return bundle.entry.map(e => {
    const r = e.resource;
    return {
      value: r.valueQuantity?.value ?? null,
      date:  (r.effectiveDateTime || r.effectivePeriod?.start || "").slice(0, 10),
      unit:  r.valueQuantity?.unit || ""
    };
  }).filter(x => x.value != null).reverse(); // oldest → newest
}

/** 從血壓 Observation 取 SBP / DBP（用 LOINC 比對元件，不依 index） */
function parseBP(obs) {
  if (!obs) return { sbp: null, dbp: null };
  const comps = obs.component || [];
  let sbp = null, dbp = null;
  for (const c of comps) {
    const codes = c.code?.coding?.map(x => x.code) || [];
    if (codes.includes("8480-6")) sbp = c.valueQuantity?.value;
    if (codes.includes("8462-4")) dbp = c.valueQuantity?.value;
  }
  // fallback: component[0]/[1] if codes absent
  if (sbp == null && comps[0]) sbp = comps[0].valueQuantity?.value;
  if (dbp == null && comps[1]) dbp = comps[1].valueQuantity?.value;
  return { sbp, dbp };
}

/** 從 Condition bundle 推斷風險分層（最嚴重者優先） */
function inferRiskFromConditions(condBundle, medBundle) {
  const conditions = (condBundle?.entry || []).map(e => e.resource);
  const meds = (medBundle?.entry || []).map(e => e.resource);

  const icdCodes = [];
  for (const c of conditions) {
    (c.code?.coding || []).forEach(cd => {
      if (cd.code) icdCodes.push(cd.code.toUpperCase());
    });
  }

  // 判斷是否已使用 Statin
  const onStatin = meds.some(m => {
    const name = (
      m.medicationCodeableConcept?.coding?.[0]?.display ||
      m.medicationCodeableConcept?.text || ""
    ).toLowerCase();
    return STATIN_KEYWORDS.some(k => name.includes(k));
  });

  // ASCVD 復發（已有 Statin + MI 或 ASCVD）
  const hasASCVD = icdCodes.some(c => ["I21","I22","I25","I63"].some(p => c.startsWith(p)));
  if (hasASCVD && onStatin) return "extreme";

  // 依優先序比對
  for (const row of ICD_RISK_MAP) {
    if (row.key === "extreme") continue; // 已上面處理
    if (icdCodes.some(c => row.prefix.some(p => c.startsWith(p)))) return row.key;
  }

  return null; // 無法自動判斷
}

/** 判斷是否已使用 Ezetimibe / PCSK9 抑制劑 */
function parseMedStatus(medBundle) {
  const meds = (medBundle?.entry || []).map(e => e.resource);
  const names = meds.map(m => (
    m.medicationCodeableConcept?.coding?.[0]?.display ||
    m.medicationCodeableConcept?.text || ""
  ).toLowerCase());
  return {
    onStatin:   names.some(n => STATIN_KEYWORDS.some(k => n.includes(k))),
    onEzetimibe:names.some(n => EZETIMIBE_KEYWORDS.some(k => n.includes(k))),
    onPCSK9:    names.some(n => PCSK9_KEYWORDS.some(k => n.includes(k))),
    list:       meds
  };
}

// ═══════════════════════════════════════════
// §4  CDS 核心決策邏輯
// ═══════════════════════════════════════════

/**
 * @param {number|null} ldl   - 最新 LDL-C (mg/dL)
 * @param {string}      riskKey
 * @param {object}      medStatus  - { onStatin, onEzetimibe, onPCSK9 }
 * @param {string|null} ldlDate
 * @returns {{ html:string, ldl:number|null, target:number, gap:number|null, statusClass:string }}
 */
function evaluateCDS(ldl, riskKey, medStatus = {}, ldlDate = null) {
  const risk = RISK_CONFIG[riskKey] || RISK_CONFIG["low"];
  const target = risk.target;

  if (ldl == null) {
    return {
      html: buildDecisionHtml({
        statusClass: "status-unknown",
        title: "❓ 臨床資訊不足",
        subtitle: `此病人在 FHIR Server 上無 LDL-C 檢驗紀錄（LOINC: 13457-7 / 18262-6）`,
        ldl: null, target, ldlDate,
        risk,
        advice: "目前無法判定是否達標。請安排血脂抽血檢驗後再行評估。"
      }),
      ldl: null, target, gap: null, statusClass: "status-unknown"
    };
  }

  const gap = ldl - target;
  const achieved = ldl < target;

  // 嚴重超標門檻依風險層動態設定
  const severeThreshold = target <= 55 ? 15 : target <= 70 ? 20 : 25;
  const isSevere = gap >= severeThreshold;

  let statusClass = achieved ? "status-good" : (isSevere ? "status-danger" : "status-warning");
  let title = achieved ? "✅ 良好控制" : (isSevere ? "🚨 立即加強治療" : "⚠️ 尚未達標");

  let advice = "";
  if (achieved) {
    advice = `目前治療效果理想，LDL-C 已達標（< ${target} mg/dL）。建議維持飲食習慣與現有藥物，每 6–12 個月定期追蹤血脂。`;
  } else {
    const gapStr = gap.toFixed(1);
    if (medStatus.onPCSK9) {
      advice = `<strong>注意：</strong>病人已使用 PCSK9 抑制劑，LDL-C 仍超出目標 ${gapStr} mg/dL。建議確認用藥順從性、劑量與注射頻率，並考慮轉介脂質專科。`;
    } else if (medStatus.onEzetimibe || target <= 55) {
      advice = `<strong>專家建議（2025 共識）：</strong>LDL-C 超出目標 ${gapStr} mg/dL。`
        + (medStatus.onEzetimibe
          ? `病人已使用 Ezetimibe，建議加用 <strong>PCSK9 抑制劑</strong>（Evolocumab / Alirocumab），可降低 LDL-C 50–60%。`
          : `建議在最大耐受劑量 Statin 基礎上，合併 <strong>Ezetimibe</strong>；若仍未達標，考慮 <strong>PCSK9 抑制劑</strong>。`);
    } else if (isSevere) {
      advice = `<strong>專家建議（2025 共識）：</strong>LDL-C 顯著超出目標 ${gapStr} mg/dL。`
        + `建議在最大耐受劑量 Statin 之外，合併使用 <strong>Ezetimibe</strong>；若仍未達標，考慮 <strong>PCSK9 抑制劑</strong>。`;
    } else {
      advice = `<strong>專家建議（2025 共識）：</strong>LDL-C 超出目標 ${gapStr} mg/dL。`
        + `請確認藥物順從性，考慮調升 Statin 劑量或換用強效型（Rosuvastatin / Atorvastatin），必要時合併 <strong>Ezetimibe</strong>。`;
    }
  }

  return {
    html: buildDecisionHtml({ statusClass, title, subtitle: null, ldl, target, ldlDate, risk, advice, gap }),
    ldl, target, gap, statusClass
  };
}

function buildDecisionHtml({ statusClass, title, subtitle, ldl, target, ldlDate, risk, advice, gap }) {
  const ldlDisplay = ldl != null ? fmtLipid(ldl) : "—";
  const gapDisplay = gap != null ? `${gap > 0 ? "+" : ""}${gap.toFixed(1)} mg/dL` : "—";
  const dateStr = ldlDate ? `&nbsp;｜&nbsp; 檢驗日期：${ldlDate}` : "";
  const subLine = subtitle
    || `治療目標：&lt; ${target} mg/dL &nbsp;｜&nbsp; 差距：${gapDisplay}${dateStr}`;

  return `<div class="decision ${statusClass}">
    <div class="decision-header">
      <div>
        <div class="decision-title">${title}</div>
        <div class="decision-value">${subLine}</div>
      </div>
      <div class="decision-ldl-badge">
        <div class="decision-ldl-num">${ldlDisplay}</div>
        <div class="decision-ldl-label">LDL-C mg/dL</div>
      </div>
    </div>
    <hr class="decision-divider">
    <div class="decision-body">
      <strong>風險分層：</strong>${risk.icon} ${risk.label}（${risk.desc}）<br><br>
      ${advice}
    </div>
  </div>`;
}

// ═══════════════════════════════════════════
// §5  病人卡片渲染
// ═══════════════════════════════════════════
function renderPatientCard(pJson, patientId, opts = {}) {
  const {
    nameEl, metaEl, chipsEl, avatarEl,
    ctxServerEl, ctxPatientEl, ctxPractitionerEl, ctxEncounterEl, contextBarEl
  } = opts;

  if (!pJson) {
    if (nameEl) nameEl.textContent = "（查無此病人）";
    if (metaEl) metaEl.textContent = `FHIR ID: ${patientId}`;
    return;
  }

  const nameObj = pJson.name?.[0];
  const name = nameObj?.text || [nameObj?.family, ...(nameObj?.given || [])].filter(Boolean).join(" ") || "（未提供姓名）";
  const gender = pJson.gender === "male" ? "男性" : pJson.gender === "female" ? "女性" : pJson.gender || "—";
  const age = pJson.birthDate ? calcAge(pJson.birthDate) + " 歲" : "—";

  if (nameEl) nameEl.textContent = name;
  if (metaEl) metaEl.textContent = `性別：${gender}　出生：${pJson.birthDate || "—"}　年齡：${age}`;
  if (avatarEl) avatarEl.textContent = pJson.gender === "male" ? "👨" : pJson.gender === "female" ? "👩" : "👤";

  if (chipsEl) {
    chipsEl.innerHTML = "";
    const addChip = (text, cls) => {
      const c = document.createElement("span");
      c.className = `chip ${cls}`; c.textContent = text; chipsEl.appendChild(c);
    };
    addChip(`FHIR ID：${patientId}`, "chip-blue");
    if (pJson.gender) addChip(gender, "chip-gray");
    if (pJson.birthDate) addChip(age, "chip-gray");
    (pJson.identifier || []).slice(0, 2).forEach(id => { if (id.value) addChip(id.value, "chip-gray"); });
  }
}

// ═══════════════════════════════════════════
// §6  衛教內容生成
// ═══════════════════════════════════════════
function buildEducationHTML(ldl, riskKey, medStatus = {}) {
  const risk = RISK_CONFIG[riskKey] || RISK_CONFIG["low"];
  const target = risk.target;
  const achieved = ldl != null && ldl < target;

  const dietItems = [
    { icon:"🐟", title:"增加 Omega-3",    text:"每週 2–3 次深海魚（鮭魚、鯖魚），有助降低 TG 並改善血脂比例" },
    { icon:"🥦", title:"高纖蔬菜",         text:"每日 5 份蔬果，水溶性纖維（燕麥、豆類）可直接降低 LDL-C" },
    { icon:"🫒", title:"健康油脂",         text:"以橄欖油取代豬油；植物固醇乳瑪琳每日 2 g 可輔助降 LDL" },
    { icon:"🥩", title:"減少飽和脂肪",     text:"紅肉每週少於 3 份；全脂乳品改為低脂或脫脂" },
    { icon:"🚫", title:"戒除反式脂肪",     text:"避免酥油製品、油炸食物及部分人造奶油" },
    { icon:"🧂", title:"低鈉控醣",         text:"精緻糖與含糖飲料升高 TG 及小顆緻密 LDL，每日鈉 &lt; 2,400 mg" }
  ];

  const exItems = [
    { icon:"🚶", title:"有氧運動",   text:"每週 ≥ 150 分鐘中等強度有氧（快走、游泳、腳踏車），可降 LDL 5–10%" },
    { icon:"🏋️", title:"肌力訓練",   text:"每週 2 次全身肌群訓練，改善胰島素阻抗並提升 HDL-C" },
    { icon:"📏", title:"體重控制",   text:"BMI 18.5–24；每降 1 kg，LDL-C 約下降 1 mg/dL" }
  ];

  const medItems = [];
  if (target <= 130) medItems.push({ icon:"💊", title:"Statin（他汀類）", text:"睡前服用效果最佳；出現不明原因肌肉痠痛請回診" });
  if (target <= 100) medItems.push({ icon:"💊", title:"Ezetimibe（益糾脂）", text:"阻斷腸道膽固醇吸收，耐受性良好，可單獨或合併使用" });
  if (target <= 70)  medItems.push({ icon:"💉", title:"PCSK9 抑制劑", text:"每 2–4 週皮下注射；可降 LDL 50–60%，用於 Statin＋Ezetimibe 仍未達標時" });
  medItems.push({ icon:"📅", title:"定期追蹤", text:`血脂每 ${achieved ? "6–12" : "3–6"} 個月追蹤；同時監測 ALT、CK 評估藥物耐受性` });

  const alertStyle = achieved
    ? "background:#f0fdf4;border-color:#86efac;color:#166534;"
    : "background:#fffbeb;border-color:#fde68a;color:#78350f;";
  const alertMsg = achieved
    ? `LDL-C ${fmtLipid(ldl)} mg/dL 已達標（目標 &lt; ${target} mg/dL）。請持續配合衛教、按時服藥並定期回診。`
    : `LDL-C ${ldl != null ? fmtLipid(ldl) + " mg/dL" : "數值未知"}，尚未達到目標 &lt; ${target} mg/dL，請與醫師討論調整治療計畫。`;

  const itemHtml = arr => arr.map(i => `
    <div class="edu-item">
      <span class="edu-item-icon">${i.icon}</span>
      <div class="edu-item-text"><div class="edu-item-title">${i.title}</div>${i.text}</div>
    </div>`).join("");

  const goodFoods = ["燕麥","糙米","豆腐","毛豆","核桃","杏仁","亞麻籽","藍莓","蘋果","菠菜","花椰菜","鮭魚","鯖魚","橄欖油"];
  const badFoods  = ["豬油","奶油","炸雞","薯條","加工香腸","動物內臟","全脂奶","椰子油","棕櫚油","含糖飲料","蛋糕酥皮","奶精"];
  const symptoms  = ["不明原因肌肉痠痛或無力","茶色或深褐色尿液（橫紋肌溶解）","嚴重疲勞感","上腹部疼痛（肝功能異常）","新發皮疹或過敏症狀"];

  return `
    <div class="edu-alert" style="${alertStyle}border-radius:10px;margin-bottom:18px;padding:12px 16px;display:flex;gap:10px;align-items:flex-start;border:1px solid transparent;">
      <span style="font-size:16px;flex-shrink:0;">${achieved ? "✅" : "⚠️"}</span>
      <span style="font-size:13px;line-height:1.7;">${alertMsg}</span>
    </div>
    <div class="edu-section">
      <div class="edu-section-title">🥗 飲食建議</div>
      <div class="edu-grid">${itemHtml(dietItems)}</div>
    </div>
    <div class="edu-section">
      <div class="edu-section-title">🏃 運動建議</div>
      <div class="edu-grid">${itemHtml(exItems)}</div>
    </div>
    <div class="edu-section">
      <div class="edu-section-title">💊 用藥衛教</div>
      <div class="edu-grid">${itemHtml(medItems)}</div>
    </div>
    <div class="edu-section">
      <div class="edu-section-title">✅ 建議食物 &nbsp;&nbsp; 🚫 應避免食物</div>
      <div style="margin-bottom:8px;display:flex;flex-wrap:wrap;gap:7px;">
        ${goodFoods.map(t=>`<span class="edu-tag edu-tag-green">✓ ${t}</span>`).join("")}
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:7px;">
        ${badFoods.map(t=>`<span class="edu-tag edu-tag-red">✗ ${t}</span>`).join("")}
      </div>
    </div>
    <div class="edu-section">
      <div class="edu-section-title">⚠️ 出現以下症狀請立即回診</div>
      <div style="display:flex;flex-wrap:wrap;gap:7px;">
        ${symptoms.map(t=>`<span class="edu-tag edu-tag-yellow">🔔 ${t}</span>`).join("")}
      </div>
    </div>`;
}

// ═══════════════════════════════════════════
// §7  FHIR 查詢輔助
// ═══════════════════════════════════════════

/**
 * 查詢單一 LOINC 代碼群中最新一筆
 */
async function queryLatestObs(client, patientId, loincCodes, count = 1) {
  const codeParam = loincCodes.join(",");
  try {
    return await client.request(
      `Observation?patient=${patientId}&code=${codeParam}&_sort=-date&_count=${count}`
    );
  } catch (e) {
    console.warn("Observation query failed:", codeParam, e);
    return null;
  }
}

/**
 * 查詢血脂完整面板（LDL, TC, HDL, TG）+ 歷史 LDL
 */
async function queryLipidPanel(client, patientId) {
  const [ldlBundle, tcBundle, hdlBundle, tgBundle, ldlHistory] = await Promise.all([
    queryLatestObs(client, patientId, LOINC.LDL, 1),
    queryLatestObs(client, patientId, LOINC.TC,  1),
    queryLatestObs(client, patientId, LOINC.HDL, 1),
    queryLatestObs(client, patientId, LOINC.TG,  1),
    queryLatestObs(client, patientId, LOINC.LDL, 10)  // 歷史趨勢
  ]);
  return {
    ldl:    firstObsValue(ldlBundle),
    tc:     firstObsValue(tcBundle),
    hdl:    firstObsValue(hdlBundle),
    tg:     firstObsValue(tgBundle),
    ldlHistory: allObsValues(ldlHistory)
  };
}

/**
 * 查詢 Condition（用於自動風險分層）
 */
async function queryConditions(client, patientId) {
  try {
    return await client.request(
      `Condition?patient=${patientId}&clinical-status=active&_count=50`
    );
  } catch (e) {
    console.warn("Condition query failed:", e);
    return null;
  }
}

/**
 * 查詢 MedicationRequest
 */
async function queryMedications(client, patientId, count = 20) {
  try {
    return await client.request(
      `MedicationRequest?patient=${patientId}&status=active&_sort=-authoredOn&_count=${count}`
    );
  } catch (e) {
    console.warn("MedicationRequest query failed:", e);
    return null;
  }
}

// ═══════════════════════════════════════════
// §8  Export（瀏覽器全域）
// ═══════════════════════════════════════════
window.CDS = {
  RISK_CONFIG,
  LOINC,
  fmtLipid,
  calcAge,
  firstObsValue,
  allObsValues,
  parseBP,
  inferRiskFromConditions,
  parseMedStatus,
  evaluateCDS,
  renderPatientCard,
  buildEducationHTML,
  queryLatestObs,
  queryLipidPanel,
  queryConditions,
  queryMedications
};

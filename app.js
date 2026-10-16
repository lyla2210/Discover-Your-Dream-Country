const state = {
  index: 0,
  answers: [],
  chart: null,
};

const OPTION_KEYS = ["A", "B", "C", "D"];

/* ---------- 用户画像 ---------- */

function emptyVector() {
  const v = {};
  DIM_KEYS.forEach((k) => {
    v[k] = 0;
  });
  return v;
}

/** 各维理论最大分 = 每题该维可选最高分之和 */
function maxPossibleVector() {
  const totals = emptyVector();
  QUESTIONS.forEach((q) => {
    DIM_KEYS.forEach((k) => {
      let best = 0;
      OPTION_KEYS.forEach((opt) => {
        best = Math.max(best, q.options[opt].scores?.[k] || 0);
      });
      totals[k] += best;
    });
  });
  return totals;
}

const MAX_VECTOR = maxPossibleVector();

function collectHardFlags(answers) {
  const hard = { climate: null, language: null, cost: null, extras: [] };
  answers.forEach((opt, i) => {
    if (!opt) return;
    const flag = QUESTIONS[i].options[opt].hard;
    if (!flag) return;
    if (flag.climate) {
      if (flag.climate === "accept_dark_winter") hard.extras.push("accept_dark_winter");
      else hard.climate = flag.climate;
    }
    if (flag.language) hard.language = flag.language;
    if (flag.cost) {
      if (["high_ok", "high_for_opportunity", "prefer_mid", "prefer_low"].includes(flag.cost)) {
        hard.cost = flag.cost;
      } else if (flag.cost === "accept_expensive") {
        hard.extras.push("accept_expensive");
      } else {
        hard.extras.push(flag.cost);
      }
    }
  });
  return hard;
}

function buildUserProfile(answers) {
  const raw = emptyVector();
  answers.forEach((opt, i) => {
    if (!opt) return;
    const scores = QUESTIONS[i].options[opt].scores || {};
    DIM_KEYS.forEach((k) => {
      raw[k] += scores[k] || 0;
    });
  });

  const profile = {};
  DIM_KEYS.forEach((k) => {
    const max = MAX_VECTOR[k] || 1;
    profile[k] = Math.round((raw[k] / max) * 1000) / 10;
  });

  return { raw, profile, hard: collectHardFlags(answers) };
}

/* ---------- 相似度 ---------- */

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  DIM_KEYS.forEach((k) => {
    const x = a[k] || 0;
    const y = b[k] || 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  });
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function euclideanSimilarity(user100, countryVec) {
  let sum = 0;
  DIM_KEYS.forEach((k) => {
    const d = (user100[k] || 0) - (countryVec[k] || 0) * 10;
    sum += d * d;
  });
  const dist = Math.sqrt(sum);
  const maxDist = Math.sqrt(DIM_KEYS.length * 100 * 100);
  return 1 - dist / maxDist;
}

function countryProfile100(country) {
  const out = {};
  DIM_KEYS.forEach((k) => {
    out[k] = (country.vector[k] || 0) * 10;
  });
  return out;
}

/* ---------- 硬过滤 ---------- */

function applyHardFilters(hard, country) {
  const penalties = [];
  let multiplier = 1;

  // —— 气候 ——
  if (hard.climate === "warm") {
    if (country.climate === "cold") {
      const soften = hard.extras.includes("accept_dark_winter");
      const m = soften ? 0.85 : 0.7;
      multiplier *= m;
      penalties.push({
        type: "climate",
        factor: m,
        text: soften
          ? `你偏好阳光温暖气候，虽能忍受长冬，${country.name}仍被适度下调`
          : `你必须阳光充足、怕冷，所以${country.name}（冬季偏冷）排名被下调`,
      });
    } else if (country.climate === "mild" && !hard.extras.includes("accept_dark_winter")) {
      // 温和国轻微保留，不降
    }
  }

  if (hard.climate === "cold") {
    if (country.climate === "warm" || country.climate === "tropical") {
      const m = country.climate === "tropical" ? 0.7 : 0.78;
      multiplier *= m;
      penalties.push({
        type: "climate",
        factor: m,
        text: `你喜欢寒冷/下雪，所以${country.name}（偏暖或热带）排名被下调`,
      });
    }
  }

  if (hard.climate === "mild") {
    if (country.climate === "tropical") {
      const m = 0.8;
      multiplier *= m;
      penalties.push({
        type: "climate",
        factor: m,
        text: `你偏好四季温和，所以${country.name}（热带）排名被下调`,
      });
    } else if (country.climate === "cold" && !hard.extras.includes("accept_dark_winter")) {
      const m = 0.85;
      multiplier *= m;
      penalties.push({
        type: "climate",
        factor: m,
        text: `你偏好温和四季，所以${country.name}（冬季偏长）排名被小幅下调`,
      });
    }
  }

  // —— 语言 ——
  if (hard.language === "english_only" && country.language === "local_hard") {
    const m = 0.72;
    multiplier *= m;
    penalties.push({
      type: "language",
      factor: m,
      text: `你希望英语解决大部分问题，所以${country.name}（当地语言门槛高）排名被下调`,
    });
  } else if (hard.language === "english_early" && country.language === "local_hard") {
    const m = 0.82;
    multiplier *= m;
    penalties.push({
      type: "language",
      factor: m,
      text: `你前期仍需英语支持，所以${country.name}（当地语言为主）排名被下调`,
    });
  } else if (hard.language === "learn_local" && country.language === "english") {
    // 愿意认真学当地语时，纯英语国不再额外加分，轻微下调防扎堆英语国
    const m = 0.92;
    multiplier *= m;
    penalties.push({
      type: "language",
      factor: m,
      text: `你愿意认真学习当地语言，纯英语环境对你的加分被略微下调`,
    });
  }

  // —— 成本 ——
  const highCostCountries = country.cost === "high";
  if (hard.cost === "prefer_low" && highCostCountries) {
    const soften = hard.extras.includes("accept_expensive");
    const m = soften ? 0.85 : 0.7;
    multiplier *= m;
    penalties.push({
      type: "cost",
      factor: m,
      text: soften
        ? `你更在意性价比，虽能忍受高房租，${country.name}仍被下调`
        : `你希望生活成本尽量低，所以${country.name}（高成本）排名被下调`,
    });
  } else if (hard.cost === "prefer_mid" && highCostCountries) {
    const soften = hard.extras.includes("accept_expensive");
    const m = soften ? 0.9 : 0.8;
    multiplier *= m;
    penalties.push({
      type: "cost",
      factor: m,
      text: `你偏好中等偏低成本，所以${country.name}（生活成本偏高）排名被下调`,
    });
  }
  // high_ok / high_for_opportunity：不降权

  return { multiplier: Math.max(0.55, Math.round(multiplier * 1000) / 1000), penalties };
}

/** 流行度修正：热门略降，冷门略抬 */
function popularityFactor(country) {
  return 1.06 - 0.16 * (country.popularity || 0.5);
}

/* ---------- 排名 ---------- */

function rankCountries(profile, hard) {
  const scored = COUNTRIES.map((country) => {
    const c100 = countryProfile100(country);
    const cos = cosineSimilarity(profile, c100);
    const euc = euclideanSimilarity(profile, country.vector);
    const baseSim = cos * 0.85 + euc * 0.15;

    const { multiplier, penalties } = applyHardFilters(hard, country);
    const pop = popularityFactor(country);
    const finalSim = baseSim * multiplier * pop;

    return {
      country,
      baseSim,
      cos,
      euc,
      filterMultiplier: multiplier,
      popularityFactor: pop,
      penalties,
      score: finalSim,
      match: Math.round(finalSim * 1000) / 10,
    };
  }).sort((a, b) => b.score - a.score);

  const top3 = scored.slice(0, 3);
  const sum = top3.reduce((s, r) => s + r.score, 0) || 1;

  return {
    all: scored,
    top3: top3.map((r) => ({
      ...r,
      percent: Math.round((r.score / sum) * 1000) / 10,
    })),
  };
}

function topUserDims(profile, n = 3) {
  return DIM_KEYS.map((k) => ({ key: k, value: profile[k] }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

function buildReasons(profile, hard, match) {
  const { country, penalties } = match;
  const userTops = topUserDims(profile, 3);
  const reasons = [];

  const topNames = userTops
    .slice(0, 2)
    .map((o) => `${DIMENSIONS[o.key].name}（${o.key}）`)
    .join("、");

  reasons.push(
    `你的 8 维画像最突出的是「${topNames}」，与${country.name}（${country.portrait}）的国家向量最为接近。`
  );

  const primary = userTops[0];
  const dim = DIMENSIONS[primary.key];
  reasons.push(
    `「${dim.name}」得分约 ${primary.value}/100：${dim.needs}。这与${country.name}的供给高度同向。`
  );

  reasons.push(
    `当地主要吸引力：${country.attractions.join("、")}，对应你在日常与关系题中的稳定偏好。`
  );

  if (penalties.length) {
    penalties.forEach((p) => {
      reasons.push(`硬过滤：${p.text}（×${p.factor}）。`);
    });
  } else {
    reasons.push(`气候、语言与成本偏好未与${country.name}明显冲突，未做硬降权。`);
  }

  if (country.challenges.length) {
    reasons.push(`适应点提醒：${country.challenges.join("、")}。`);
  }

  return reasons;
}

/* ---------- DOM ---------- */

const $ = (sel) => document.querySelector(sel);

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => {
    el.classList.toggle("is-active", el.id === id);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/** 前端展示时去掉括号及其中内容（中英文括号） */
function displayText(text) {
  return String(text || "")
    .replace(/（[^）]*）/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[ \t]+$/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function renderQuestion() {
  const i = state.index;
  const item = QUESTIONS[i];
  const total = QUESTIONS.length;

  $("#progress-fill").style.width = `${((i + 1) / total) * 100}%`;
  $("#progress-text").textContent = `${i + 1} / ${total}`;
  $("#section-label").textContent = item.section;
  $("#question-text").textContent = displayText(item.q);

  const optionsEl = $("#options");
  optionsEl.innerHTML = "";
  OPTION_KEYS.forEach((key) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option";
    const label = displayText(item.options[key].text);
    btn.innerHTML = `<span class="option-key">${key}</span><span class="option-text">${label}</span>`;
    if (state.answers[i] === key) btn.classList.add("is-selected");
    btn.addEventListener("click", () => selectAnswer(key));
    optionsEl.appendChild(btn);
  });

  $("#btn-prev").disabled = i === 0;
  $("#btn-next").textContent = i === total - 1 ? "查看结果" : "下一题";
  $("#btn-next").disabled = !state.answers[i];
}

function selectAnswer(key) {
  state.answers[state.index] = key;
  document.querySelectorAll(".option").forEach((el) => {
    el.classList.toggle(
      "is-selected",
      el.querySelector(".option-key").textContent === key
    );
  });
  $("#btn-next").disabled = false;

  if (state.index < QUESTIONS.length - 1) {
    window.setTimeout(() => {
      if (state.answers[state.index] === key) {
        state.index += 1;
        renderQuestion();
      }
    }, 280);
  }
}

function goNext() {
  if (!state.answers[state.index]) return;
  if (state.index < QUESTIONS.length - 1) {
    state.index += 1;
    renderQuestion();
  } else {
    showResults();
  }
}

function goPrev() {
  if (state.index > 0) {
    state.index -= 1;
    renderQuestion();
  }
}

function showResults() {
  const { profile, hard } = buildUserProfile(state.answers);
  const { top3 } = rankCountries(profile, hard);
  const top = top3[0];
  const reasons = buildReasons(profile, hard, top);

  showScreen("screen-result");
  renderRadar(profile);

  const c = top.country;
  $("#result-flag").textContent = c.flag;
  $("#result-country").textContent = c.name;
  $("#result-portrait").textContent = c.portrait;
  $("#result-match").textContent = `${top.match}%`;
  $("#result-blurb").textContent = c.blurb;

  const penaltyEl = $("#result-penalties");
  if (top.penalties.length) {
    penaltyEl.hidden = false;
    penaltyEl.innerHTML = `
      <div class="penalty-title">匹配度调整说明</div>
      <ul class="penalty-list">
        ${top.penalties.map((p) => `<li>${p.text}</li>`).join("")}
      </ul>`;
  } else {
    penaltyEl.hidden = true;
    penaltyEl.innerHTML = "";
  }

  $("#result-attractions").innerHTML = c.attractions
    .map((a) => `<li>${a}</li>`)
    .join("");

  $("#result-reasons").innerHTML = reasons.map((r) => `<li>${r}</li>`).join("");

  $("#result-others").innerHTML = top3
    .slice(1)
    .map((r, idx) => {
      const penHint = r.penalties.length
        ? `<div class="other-pen">${r.penalties[0].text}</div>`
        : "";
      return `
      <div class="other-item" style="--delay:${idx * 80}ms">
        <div class="other-rank">#${idx + 2}</div>
        <div class="other-main">
          <span class="other-flag">${r.country.flag}</span>
          <div>
            <div class="other-name">${r.country.name}</div>
            <div class="other-portrait">${r.country.portrait} · 匹配 ${r.match}%</div>
            ${penHint}
          </div>
        </div>
        <div class="other-bar-wrap">
          <div class="other-bar" style="width:${Math.min(100, (r.match / top.match) * 100)}%"></div>
        </div>
        <div class="other-pct" title="占前三名份额">${r.percent}%</div>
      </div>`;
    })
    .join("");

  $("#dim-summary").innerHTML = DIM_KEYS.map((k) => {
    const pct = Math.round(profile[k]);
    return `
      <div class="dim-pill">
        <span class="dim-name">${DIMENSIONS[k].short}</span>
        <span class="dim-val">${pct}</span>
        <span class="dim-track"><span class="dim-fill" style="width:${pct}%"></span></span>
      </div>`;
  }).join("");
}

function renderRadar(profile) {
  const canvas = $("#radar-chart");
  const ctx = canvas.getContext("2d");
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }

  state.chart = new Chart(ctx, {
    type: "radar",
    data: {
      labels: DIM_KEYS.map((k) => DIMENSIONS[k].short),
      datasets: [
        {
          label: "你的生活画像",
          data: DIM_KEYS.map((k) => Math.round(profile[k])),
          fill: true,
          backgroundColor: "rgba(14, 116, 144, 0.22)",
          borderColor: "#0e7490",
          pointBackgroundColor: "#ea580c",
          pointBorderColor: "#fff",
          borderWidth: 2,
          pointRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      animation: { duration: 900, easing: "easeOutQuart" },
      scales: {
        r: {
          min: 0,
          max: 100,
          ticks: { stepSize: 25, display: false },
          grid: { color: "rgba(15, 23, 42, 0.08)" },
          angleLines: { color: "rgba(15, 23, 42, 0.1)" },
          pointLabels: {
            color: "#334155",
            font: { size: 11, family: "'Noto Serif SC', serif" },
          },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => DIMENSIONS[DIM_KEYS[items[0].dataIndex]].name,
            label: (ctx) => `${ctx.parsed.r} / 100`,
          },
        },
      },
    },
  });
}

const AUTH_KEY = "shiguo_unlocked";

function normalizeCode(value) {
  return String(value || "")
    .trim()
    // 去掉列表序号，如 "1. SK-XXXX" / "12、SK-XXXX"
    .replace(/^\d+[\.\)\、\．]\s*/, "")
    // 全角字母数字与连字符 → 半角
    .replace(/[Ａ-Ｚａ-ｚ０-９－]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .replace(/[–—−－]/g, "-")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toUpperCase()
    .replace(/\s+/g, "");
}

function getAccessCodes() {
  if (Array.isArray(window.ACCESS_CODES)) return window.ACCESS_CODES;
  if (typeof ACCESS_CODES !== "undefined" && Array.isArray(ACCESS_CODES)) {
    return ACCESS_CODES;
  }
  return null;
}

function isUnlocked() {
  return sessionStorage.getItem(AUTH_KEY) === "1";
}

function setUnlocked(on) {
  if (on) sessionStorage.setItem(AUTH_KEY, "1");
  else sessionStorage.removeItem(AUTH_KEY);
}

function refreshAuthUI() {
  const unlocked = isUnlocked();
  const authBox = $("#auth-box");
  const startWrap = $("#start-wrap");
  if (authBox) authBox.hidden = unlocked;
  if (startWrap) startWrap.hidden = !unlocked;
}

function markUnlocked() {
  const input = $("#auth-input");
  const hint = $("#auth-hint");
  input.classList.remove("is-error");
  hint.className = "auth-hint is-ok";
  hint.textContent = "授权成功，可以开始测试。";
  setUnlocked(true);
  refreshAuthUI();
}

function markInvalid(message) {
  const input = $("#auth-input");
  const hint = $("#auth-hint");
  input.classList.add("is-error");
  hint.className = "auth-hint is-error";
  hint.textContent = message;
}

function unlockFromLocalList(code) {
  const pool = getAccessCodes();
  if (!pool) return false;
  return pool.some((item) => normalizeCode(item) === code);
}

async function tryUnlock() {
  const input = $("#auth-input");
  const code = normalizeCode(input.value);

  if (!code) {
    markInvalid("请先输入授权码。");
    return;
  }

  try {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.status !== 404) {
      const data = await res.json().catch(() => ({}));
      if (data.ok) {
        markUnlocked();
        return;
      }
      if (data.reason !== "missing_env") {
        markInvalid("授权码无效。请只粘贴码本身，例如 SK-2AQ55C（不要带序号）。");
        return;
      }
    }
  } catch (err) {
    // 本地静态预览没有接口时，改用页面内授权码列表
  }

  if (unlockFromLocalList(code)) {
    markUnlocked();
    return;
  }

  markInvalid("授权码无效。请只粘贴码本身，例如 SK-2AQ55C（不要带序号）。");
}

function lockAccess() {
  setUnlocked(false);
  state.index = 0;
  state.answers = [];
  const input = $("#auth-input");
  const hint = $("#auth-hint");
  if (input) {
    input.value = "";
    input.classList.remove("is-error");
  }
  if (hint) {
    hint.className = "auth-hint";
    hint.textContent = "请使用发放的授权码，任选其一即可。";
  }
  refreshAuthUI();
  showScreen("screen-home");
}

function restart() {
  state.index = 0;
  state.answers = [];
  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }
  showScreen("screen-home");
  refreshAuthUI();
}

function startQuiz() {
  if (!isUnlocked()) {
    refreshAuthUI();
    $("#auth-hint").className = "auth-hint is-error";
    $("#auth-hint").textContent = "请先输入有效授权码。";
    return;
  }
  state.index = 0;
  state.answers = [];
  showScreen("screen-quiz");
  renderQuestion();
}

document.addEventListener("DOMContentLoaded", () => {
  refreshAuthUI();
  $("#btn-unlock").addEventListener("click", tryUnlock);
  $("#auth-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") tryUnlock();
  });
  $("#btn-lock").addEventListener("click", lockAccess);
  $("#btn-start").addEventListener("click", startQuiz);
  $("#btn-next").addEventListener("click", goNext);
  $("#btn-prev").addEventListener("click", goPrev);
  $("#btn-restart").addEventListener("click", restart);
  $("#btn-home").addEventListener("click", restart);
});

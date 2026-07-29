// ai-morning-letter — front page logic
// Loads archive.json and renders a card grid grouped by month, with
// a search box (full-text over date / kicker / headline / query) and
// kicker-chip category filters (click to toggle, multiple = AND).
(function () {
  "use strict";

  const listEl = document.getElementById("archive-months");
  const searchEl = document.getElementById("archive-search");
  const countEl = document.getElementById("archive-count");
  const totalEl = document.getElementById("total-count");
  if (!listEl) return;

  let items = [];
  /** @type {Set<string>} */
  const activeKickers = new Set();

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function monthKey(iso) {
    const d = new Date(iso + "T12:00:00Z");
    return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  }

  function kickerBadge(k) {
    if (!k) return "";
    const m = k.match(/\[(MODEL|PRODUCT|RESEARCH|FUNDING|POLICY|SECURITY|TOOLING|OPEN-SOURCE)\]/);
    if (!m) return "";
    return `<span class="kicker-pill" data-cat="${escapeHtml(m[1])}">${escapeHtml(m[1])}</span>`;
  }

  function kickerPillsList(it) {
    const out = [];
    if (it.first_kicker) out.push(kickerBadge(it.first_kicker));
    if (Array.isArray(it.queries)) {
      for (const q of it.queries.slice(0, 2)) {
        out.push(`<span class="meta-pill">⌕ ${escapeHtml(q)}</span>`);
      }
    }
    return out.join("");
  }

  function renderCard(it) {
    const dateLabel = escapeHtml(it.date);
    const stories = it.n_stories || 0;
    const titleAttr = escapeHtml(it.title || ("Morning Letter — " + it.date));
    const desc = escapeHtml(it.description || "");
    const audioBadge = it.has_audio
      ? '<span class="card-audio" title="Audio edition available">🎧 Listen</span>'
      : "";
    return `
<article class="archive-card">
  <div class="card-top">
    <span class="card-date">${dateLabel}</span>
    <span class="card-stories">${stories} stor${stories === 1 ? "y" : "ies"}</span>
    ${audioBadge}
  </div>
  <a class="card-title" href="${escapeHtml(it.url)}">${titleAttr}</a>
  ${desc ? `<p class="card-desc">${desc}</p>` : ""}
  <div class="card-kickers">${kickerPillsList(it)}</div>
</article>
`;
  }

  function stripBrackets(k) {
    if (!k) return "";
    const m = k.match(/\[(MODEL|PRODUCT|RESEARCH|FUNDING|POLICY|SECURITY|TOOLING|OPEN-SOURCE)\]/);
    return m ? m[1] : k;
  }

  function matchesItem(it, f, kickers) {
    if (kickers.size > 0) {
      const k = stripBrackets(it.first_kicker);
      if (!kickers.has(k)) return false;
    }
    if (f) {
      const haystack = [
        it.date, it.title || "",
        it.first_kicker || "",
        (it.queries || []).join(" "),
        it.description || "",
        String(it.n_stories || ""),
      ].join(" ").toLowerCase();
      if (haystack.indexOf(f) === -1) return false;
    }
    return true;
  }

  function render() {
    const f = (searchEl ? searchEl.value : "").trim().toLowerCase();
    listEl.innerHTML = "";
    let lastMonth = null;
    let shown = 0;

    items.forEach(function (it) {
      if (!matchesItem(it, f, activeKickers)) return;

      const mk = monthKey(it.date);
      if (mk !== lastMonth) {
        const block = document.createElement("section");
        block.className = "month-block";
        block.innerHTML = `<h2 class="month-label">${escapeHtml(mk)}</h2><div class="archive-grid"></div>`;
        listEl.appendChild(block);
        lastMonth = mk;
      }

      const grid = block_or_last_grid();
      if (!grid) return;
      grid.insertAdjacentHTML("beforeend", renderCard(it));
      shown++;
    });

    if (shown === 0) {
      listEl.innerHTML = `<p class="empty-state">No editions match that filter. Try clearing a chip or a different word.</p>`;
    }
    if (countEl) {
      const filterActive = f || activeKickers.size > 0;
      countEl.textContent = filterActive
        ? shown + " of " + items.length + " match"
        : items.length + " edition" + (items.length === 1 ? "" : "s");
    }
    if (totalEl && !f && activeKickers.size === 0) totalEl.textContent = String(items.length);
  }

  function block_or_last_grid() {
    const blocks = listEl.querySelectorAll(".month-block");
    if (blocks.length === 0) return null;
    return blocks[blocks.length - 1].querySelector(".archive-grid");
  }

  function paintChipCounts() {
    const counts = {
      MODEL: 0, PRODUCT: 0, RESEARCH: 0, FUNDING: 0,
      POLICY: 0, SECURITY: 0, TOOLING: 0, "OPEN-SOURCE": 0,
    };
    items.forEach((it) => {
      const k = stripBrackets(it.first_kicker);
      if (counts[k] != null) counts[k]++;
    });
    document.querySelectorAll(".filter-chip").forEach((chip) => {
      const k = chip.dataset.kicker;
      const c = counts[k] || 0;
      let span = chip.querySelector(".chip-count");
      if (!span) {
        span = document.createElement("span");
        span.className = "chip-count";
        chip.appendChild(span);
      }
      span.textContent = String(c);
    });
  }

  function bindChips() {
    document.querySelectorAll(".filter-chip").forEach((chip) => {
      chip.addEventListener("click", function () {
        const k = chip.dataset.kicker;
        if (activeKickers.has(k)) activeKickers.delete(k);
        else activeKickers.add(k);
        chip.classList.toggle("active", activeKickers.has(k));
        render();
      });
    });
  }

  function bindKeyboard() {
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && document.activeElement !== searchEl) {
        if (searchEl) {
          e.preventDefault();
          searchEl.focus();
          searchEl.select();
        }
      }
      if (e.key === "Escape" && document.activeElement === searchEl) {
        searchEl.blur();
      }
    });
  }

  function load() {
    fetch("archive.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        items = Array.isArray(data) ? data : [];
        paintChipCounts();
        render(searchEl ? searchEl.value : "");
      })
      .catch(function (err) {
        listEl.innerHTML =
          '<p class="empty-state">Failed to load the archive: ' +
          escapeHtml(String(err)) + "</p>";
      });
  }

  if (searchEl) {
    searchEl.addEventListener("input", function (e) { render(); });
  }
  bindChips();
  bindKeyboard();
  load();
})();
// ai-morning-letter — front page logic
// Loads archive.json and renders a card grid grouped by month, with
// a search box that filters by date / kicker / headline / queries.
(function () {
  "use strict";

  const listEl = document.getElementById("archive-months");
  const searchEl = document.getElementById("archive-search");
  const countEl = document.getElementById("archive-count");
  const totalEl = document.getElementById("total-count");
  if (!listEl) return;

  let items = [];

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
    return `
<article class="archive-card">
  <div class="card-top">
    <span class="card-date">${dateLabel}</span>
    <span class="card-stories">${stories} stor${stories === 1 ? "y" : "ies"}</span>
  </div>
  <a class="card-title" href="${escapeHtml(it.url)}">${titleAttr}</a>
  ${desc ? `<p class="card-desc">${desc}</p>` : ""}
  <div class="card-kickers">${kickerPillsList(it)}</div>
</article>
`;
  }

  function render(filter) {
    const f = (filter || "").trim().toLowerCase();
    listEl.innerHTML = "";
    let lastMonth = null;
    let shown = 0;

    items.forEach(function (it) {
      const haystack = [
        it.date, it.title || "",
        it.first_kicker || "",
        (it.queries || []).join(" "),
        it.description || "",
        String(it.n_stories || ""),
      ].join(" ").toLowerCase();
      if (f && haystack.indexOf(f) === -1) return;

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
      listEl.innerHTML = `<p class="empty-state">No editions match that filter. Try a different word or browse by date.</p>`;
    }
    if (countEl) {
      countEl.textContent =
        shown === items.length
          ? shown + " edition" + (shown === 1 ? "" : "s")
          : shown + " of " + items.length + " match";
    }
    if (totalEl && !f) totalEl.textContent = String(items.length);
  }

  // Returns the .archive-grid of the most recently appended .month-block.
  function block_or_last_grid() {
    const blocks = listEl.querySelectorAll(".month-block");
    if (blocks.length === 0) return null;
    return blocks[blocks.length - 1].querySelector(".archive-grid");
  }

  function load() {
    fetch("archive.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        items = Array.isArray(data) ? data : [];
        render(searchEl ? searchEl.value : "");
      })
      .catch(function (err) {
        listEl.innerHTML =
          '<p class="empty-state">Failed to load the archive: ' +
          escapeHtml(String(err)) + "</p>";
      });
  }

  if (searchEl) {
    searchEl.addEventListener("input", function (e) { render(e.target.value); });
  }
  load();
})();

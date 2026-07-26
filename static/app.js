// ai-digest-site — front page logic
// Loads archive.json and renders the chronological list with a search box.
(function () {
  "use strict";

  const listEl = document.getElementById("archive-list");
  const searchEl = document.getElementById("archive-search");
  const countEl = document.getElementById("archive-count");
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

  function render(filter) {
    const f = (filter || "").trim().toLowerCase();
    listEl.innerHTML = "";
    let lastMonth = null;
    let shown = 0;
    items.forEach(function (it) {
      const haystack = [
        it.date, it.title, it.first_kicker || "",
        (it.queries || []).join(" "), String(it.n_stories || "")
      ].join(" ").toLowerCase();
      if (f && haystack.indexOf(f) === -1) return;
      const mk = monthKey(it.date);
      if (mk !== lastMonth) {
        const h = document.createElement("li");
        h.className = "month-header";
        h.textContent = mk;
        listEl.appendChild(h);
        lastMonth = mk;
      }
      const li = document.createElement("li");
      li.className = "archive-item";
      li.innerHTML =
        '<span class="date">' + escapeHtml(it.date) + "</span>" +
        '<span class="title"><a href="' + escapeHtml(it.url) + '">' +
        escapeHtml(it.title) + "</a></span>" +
        '<span class="count">' + escapeHtml(String(it.n_stories || 0)) + " stories</span>";
      listEl.appendChild(li);
      shown++;
    });
    if (countEl) {
      countEl.textContent = shown === items.length
        ? shown + " entries"
        : shown + " of " + items.length + " entries";
    }
  }

  function load() {
    fetch("archive.json", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) {
        items = Array.isArray(data) ? data : [];
        render("");
      })
      .catch(function (err) {
        listEl.innerHTML = '<li class="archive-item"><span class="title">Failed to load archive: ' +
          escapeHtml(String(err)) + "</span></li>";
      });
  }

  if (searchEl) {
    searchEl.addEventListener("input", function (e) { render(e.target.value); });
  }
  load();
})();

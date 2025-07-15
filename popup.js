/*  popup.js  */
/*  Everything runs inside an async IIFE so we can await secret.json   */
(async () => {

  /* ---------- Load API key & folder ID from secret.json ---------- */
  async function getSecrets() {
    try {
      const resp = await fetch(chrome.runtime.getURL("secret.json"));
      if (!resp.ok) throw new Error("secret.json not found");
      return await resp.json();                       // { API_KEY, FOLDER_ID }
    } catch (e) {
      alert("⚠️  secret.json missing or unreadable. Video features disabled.");
      throw e;
    }
  }
  const { API_KEY, FOLDER_ID } = await getSecrets();

  /* ---------- Tab switching ---------- */
  document.querySelectorAll('.tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.content-section').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
    };
  });

  /* ---------- (Late-fee calculator code – unchanged) ---------- */
  /* ... keep your existing late-fee logic here ... */

  /* ---------- Video section ---------- */
  const input  = document.getElementById("videoSearchInput"),
        aList  = document.getElementById("autocompleteList"),
        sBox   = document.getElementById("suggestions"),
        dbg    = document.getElementById("debugItems"),
        play   = document.getElementById("searchVideoBtn"),
        video  = document.getElementById("videoPlayer"),
        fsBtn  = document.getElementById("fsBtn");

  let clips = [];         // [{id,name}]
  let checkoutItems = []; // scraped strings

  const gURL = id =>
    `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${API_KEY}`;

  /* 1. Load Drive clips */
  async function loadClips() {
    const url =
      `https://www.googleapis.com/drive/v3/files?q='${FOLDER_ID}'+in+parents+and+mimeType='video/mp4'` +
      `&fields=files(id,name)&pageSize=1000&key=${API_KEY}`;
    try {
      const j = await (await fetch(url)).json();
      clips = (j.files || []).map(f => ({ id: f.id, name: f.name.replace(/\.mp4$/i, "") }));
    } catch (e) {
      console.error("Drive list error:", e);
      clips = [];
    }
  }
  await loadClips();

  /* 2. Scrape checkout items and show debug list */
  async function scrapeItems() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => Array.from(document.querySelectorAll('a[href*="wco?method=resource"]'))
                         .map(a => a.textContent.trim())
      });
      checkoutItems = (result || []).filter(Boolean);
    } catch {
      checkoutItems = [];
    }
    dbg.textContent = checkoutItems.length ? checkoutItems.join("\n") : "— no items found —";
  }
  await scrapeItems();

  /* 3. Build suggestions: every clip whose tokens (≥3 chars) all appear in ≥1 checkout string */
  function buildSuggestions() {
    sBox.innerHTML = "";
    const added = new Set();

    clips.forEach(c => {
      const tokens = c.name.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
      if (!tokens.length) return;

      const match = checkoutItems.some(item =>
        tokens.every(tok => item.toLowerCase().includes(tok))
      );

      if (match && !added.has(c.id)) {
        const div = document.createElement("div");
        div.textContent = c.name;
        div.onclick = () => { input.value = c.name; aList.innerHTML = ""; };
        sBox.appendChild(div);
        added.add(c.id);
      }
    });
  }
  buildSuggestions();

  /* 4. Autocomplete while typing */
  input.oninput = () => {
    const v = input.value.toLowerCase();
    aList.innerHTML = "";
    if (!v) return;
    clips
      .filter(c => c.name.toLowerCase().includes(v))
      .slice(0, 6)
      .forEach(c => {
        const d = document.createElement("div");
        d.textContent = c.name;
        d.onclick = () => { input.value = c.name; aList.innerHTML = ""; };
        aList.appendChild(d);
      });
  };

  /* 5. Play clip */
  function playClip(name) {
    const c = clips.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!c) { alert("Video not found."); return; }
    video.src = gURL(c.id);
    video.style.display = "block";
    fsBtn.style.display = "block";
    video.play();
  }
  play.onclick = () => playClip(input.value.trim());

  /* 6. Fullscreen via new tab */
  fsBtn.onclick = () => chrome.tabs.create({ url: video.src });

})();   // end IIFE
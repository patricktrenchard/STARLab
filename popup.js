/* popup.js – Late Fee + Video Search + visible estimate panel
   • Late-fee rule (updated):
     - $5 per FULL hour that occurs during OPEN hours.
     - If return crosses a night (close → next open), add a flat +$5 per night.
     - On later days, only count hours once the clock hits the SAME minute as the due time.
*/

(async () => {
  /* ---------------- Helpers ---------------- */
  const $  = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  async function getJSON(url){
    const r = await fetch(url);
    if(!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
  }
  const fmtDT = d => {
    const pad = n => String(n).padStart(2,"0");
    const y=d.getFullYear(), m=pad(d.getMonth()+1), da=pad(d.getDate());
    const hh=pad(d.getHours()), mm=pad(d.getMinutes());
    return `${y}-${m}-${da} ${hh}:${mm}`;
  };

  /* ---------------- Tabs ---------------- */
  $$(".tab").forEach(tab => {
    tab.onclick = () => {
      $$(".tab").forEach(t => t.classList.remove("active"));
      $$(".content-section").forEach(s => s.classList.remove("active"));
      tab.classList.add("active");
      $("#"+tab.dataset.tab).classList.add("active");
    };
  });

  /* ---------------- Late-Fee Calculator ---------------- */
  const DEFAULT_RATE  = 5; // $5 steps
  // Updated defaults to 12:00–22:00 (Mon–Fri), closed Sat/Sun.
  const DEFAULT_HOURS = [
    null, [12,0,22,0], [12,0,22,0], [12,0,22,0],
          [12,0,22,0], [12,0,22,0], null
  ];
  const HOUR_MS = 36e5;
  const dayName = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const pad     = n => String(n).padStart(2,"0");
  const hhmm    = (h,m)=>`${pad(h)}:${pad(m)}`;

  // UI refs
  const rateEl     = $("#rate");
  const saveEl     = $("#save");
  const calcEl     = $("#calc");
  const resultEl   = $("#result");
  const manualChk  = $("#manualChk");
  const manualWrap = $("#manualInputs");

  // Estimate panel refs
  const estimateBox = $("#estimateBox");
  const asOfInput   = $("#asOfInput");
  const useNowBtn   = $("#useNowBtn");
  const estimateBtn = $("#estimateBtn");
  const dueBadge    = $("#dueBadge");

  // state
  let lastDue = null; // Date used for estimate panel

  // manual inputs hidden by default
  manualWrap.style.display = "none";
  manualChk.addEventListener("change", () => {
    manualWrap.style.display = manualChk.checked ? "block" : "none";
    estimateBox.classList.toggle("hidden", !manualChk.checked);
  });

  const loadCFG = () => chrome.storage.sync.get(["rate","hours"]);
  const saveCFG = (o) => chrome.storage.sync.set(o);

  function buildTable(arr){
    const body=$("#sched tbody"); body.innerHTML="";
    arr.forEach((cfg,i)=>{
      const row=document.createElement("tr");
      row.innerHTML=`<td>${dayName[i]}</td>
        <td><input type="checkbox" class="cl"></td>
        <td><input type="time" class="op"></td>
        <td><input type="time" class="clo"></td>`;
      body.appendChild(row);

      const chk=row.querySelector(".cl"),
            op =row.querySelector(".op"),
            clo=row.querySelector(".clo");

      if(!cfg){
        chk.checked=true;
        op.disabled=clo.disabled=true;
      }else{
        [op.value,clo.value]=[hhmm(cfg[0],cfg[1]),hhmm(cfg[2],cfg[3])];
      }
      chk.oninput=()=>{op.disabled=clo.disabled=chk.checked;};
    });
  }
  function readTable(){
    return Array.from(document.querySelectorAll("#sched tbody tr")).map(r=>{
      if(r.querySelector(".cl").checked) return null;
      const op=r.querySelector(".op").value,
            clo=r.querySelector(".clo").value;
      if(!op||!clo) return null;
      const [oh,om]=op.split(":").map(Number),
            [ch,cm]=clo.split(":").map(Number);
      return [oh,om,ch,cm];
    });
  }

  // ===== Fee algorithm (YOUR clarified rules) =====
  function calcFee(due, ret, { rate, hours }){
    // Count full-hour “ticks” at the SAME minute as due, only inside open hours.
    // Each night that crosses close→open adds a flat +$5.
    const sameDay = (a,b) => a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
    const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0);
    const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate()+n, 0,0,0,0);

    if (ret <= due) return 0;

    let total = 0;
    const dueMinute = due.getMinutes();

    // Iterate day by day from due's date to return's date
    let dayCursor = startOfDay(due);
    const lastDay = startOfDay(ret);

    while (dayCursor <= lastDay) {
      const idx = dayCursor.getDay();
      const sched = hours[idx];

      if (!sched) { // closed day
        // overnight fee may still apply if we span from a prior open day past its close—handled on that prior day
        dayCursor = addDays(dayCursor, 1);
        continue;
      }

      const [oh, om, ch, cm] = sched;
      const open  = new Date(dayCursor); open .setHours(oh, om, 0, 0);
      const close = new Date(dayCursor); close.setHours(ch, cm, 0, 0);

      // Determine segment we care about on this day
      const dayStart = sameDay(dayCursor, due) ? new Date(Math.max(due.getTime(), open.getTime())) : open;
      const dayEnd   = sameDay(dayCursor, lastDay) ? new Date(Math.min(ret.getTime(), close.getTime())) : close;

      // Count hourly ticks at :dueMinute that lie within [dayStart, dayEnd]
      // First tick for the day:
      let tick = new Date(dayStart);
      tick.setMinutes(dueMinute, 0, 0);
      // For the due day: we only count AFTER the due time, so push to next tick if tick <= due
      if (sameDay(dayCursor, due) && tick <= due) tick.setHours(tick.getHours()+1);
      // For other days: ensure tick is not before open (if setting :dueMinute pushed it back)
      if (!sameDay(dayCursor, due) && tick < open) {
        // move to the first hour start at or after open, aligned to :dueMinute
        tick = new Date(open);
        tick.setMinutes(dueMinute, 0, 0);
        if (tick < open) tick.setHours(tick.getHours()+1);
      }

      // Sum full-hour ticks inside open window
      while (tick <= dayEnd && tick <= close) {
        total += rate;
        tick.setHours(tick.getHours()+1);
      }

      // Overnight flat fee:
      // If the overall return extends beyond this day's close (i.e., not returned yet by close),
      // add one +$5 for the night bridging this day to the next open.
      const returnedAfterClose = (lastDay > dayCursor) || (sameDay(dayCursor, lastDay) && ret > close);
      const dayHadOpen = open < close; // sanity
      if (dayHadOpen && returnedAfterClose) {
        // Only add if there was at least some lateness on/after this day’s due context:
        // If it's the due day, lateness starts at 'due'; else lateness already ongoing.
        const hadLatenessThisDay =
          (sameDay(dayCursor, due) && due < close) || (!sameDay(dayCursor, due));
        if (hadLatenessThisDay) total += rate;
      }

      dayCursor = addDays(dayCursor, 1);
    }

    return total;
  }

  const cfg0 = await loadCFG();
  rateEl.value = cfg0.rate  ?? DEFAULT_RATE;
  buildTable   (cfg0.hours ?? DEFAULT_HOURS);

  saveEl.onclick = async () => {
    await saveCFG({ rate:+rateEl.value||DEFAULT_RATE, hours:readTable() });
    const msg=$("#saveMsg");
    msg.textContent="✔ Saved"; setTimeout(()=>msg.textContent="",2000);
  };

  // Scrape times (allow partial)
  async function scrapeTimes(){
    try{
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      const [{result}]=await chrome.scripting.executeScript({
        target:{tabId:tab.id},
        func:()=> {
          const pick = s => document.querySelector(s)?.textContent?.trim() || null;
          const due =
            pick('span[id$=".scheduledEndTime.valueLabel"]') ||
            pick('span[id$=".scheduledReturnTime.valueLabel"]') || null;
          const ret =
            pick('span[id$=".realEndTime.valueLabel"]') ||
            pick('span[id$=".actualEndTime.valueLabel"]') || null;
          const checkout =
            pick('span[id$=".startTime.valueLabel"]') ||
            pick('span[id$=".scheduledStartTime.valueLabel"]') ||
            pick('span[id$=".checkoutTime.valueLabel"]') || null;
          return { due, ret, checkout };
        }
      });

      const d = result?.due ? new Date(result.due) : null;
      const r = result?.ret ? new Date(result.ret) : null;
      const c = result?.checkout ? new Date(result.checkout) : null;

      if(!d || isNaN(+d)) return null;
      return { due:d, ret:(r && !isNaN(+r))?r:null, checkout:(c && !isNaN(+c))?c:null };
    }catch{
      return null;
    }
  }

  // --- Estimate panel helpers ---
  function openEstimatePanel(dueDate){
    lastDue = dueDate;
    dueBadge.textContent = `Due: ${fmtDT(dueDate)}`;
    const now = new Date();
    asOfInput.value = toLocalInputValue(now);
    estimateBox.classList.remove("hidden");
    resultEl.textContent = "";
    asOfInput.focus();
  }
  function toLocalInputValue(d){
    const pad = n => String(n).padStart(2,"0");
    const y=d.getFullYear(), m=pad(d.getMonth()+1), da=pad(d.getDate());
    const hh=pad(d.getHours()), mm=pad(d.getMinutes());
    return `${y}-${m}-${da}T${hh}:${mm}`;
  }

  useNowBtn.onclick = () => {
    asOfInput.value = toLocalInputValue(new Date());
  };
  estimateBtn.onclick = async () => {
    if(!lastDue){ resultEl.textContent="⚠️ No due time available."; return; }
    if(!asOfInput.value){ resultEl.textContent="⚠️ Enter an as-of time."; return; }
    const ret = new Date(asOfInput.value);
    const cfg = await loadCFG();
    const fee = calcFee(lastDue, ret, {
      rate : cfg.rate  ?? DEFAULT_RATE,
      hours: cfg.hours ?? DEFAULT_HOURS
    });
    resultEl.textContent = `Late Fee (estimated): $${fee}`;
  };

  // Click: normal calc + show estimate if Actual End missing
  calcEl.onclick = async () => {
    resultEl.textContent="";
    estimateBox.classList.add("hidden");

    const manual = $("#manualChk").checked;

    if (manual){
      const dStr=$("#manualDue").value, rStr=$("#manualRet").value;
      if(!dStr||!rStr){ resultEl.textContent="⚠️ Enter both dates."; return; }
      const due=new Date(dStr), ret=new Date(rStr);
      if(isNaN(+due)||isNaN(+ret)){ resultEl.textContent="⚠️ Invalid date."; return; }

      const cfg = await loadCFG();
      const fee = calcFee(due, ret, {
        rate : cfg.rate  ?? DEFAULT_RATE,
        hours: cfg.hours ?? DEFAULT_HOURS
      });
      resultEl.textContent = `Late Fee: $${fee}`;
      return;
    }

    const times = await scrapeTimes();
    if(!times || !times.due){
      resultEl.textContent="⚠️ Couldn’t find timestamps on this page.";
      return;
    }

    if(!times.ret){
      openEstimatePanel(times.due);
      return;
    }

    const cfg = await loadCFG();
    const fee = calcFee(times.due, times.ret, {
      rate : cfg.rate  ?? DEFAULT_RATE,
      hours: cfg.hours ?? DEFAULT_HOURS
    });
    resultEl.textContent = `Late Fee: $${fee}`;
  };

  /* ---------------- Google Drive Video Search (unchanged) ---------------- */
  let API_KEY, FOLDER_ID;
  try {
    ({ API_KEY, FOLDER_ID } = await getJSON(chrome.runtime.getURL("secret.json")));
  } catch {
    API_KEY = FOLDER_ID = null; // calculator still works without secret.json
  }

  const videoInput = $("#videoSearchInput");
  const aList      = $("#autocompleteList");
  const sBox       = $("#suggestions");
  const playBtn    = $("#searchVideoBtn");
  const videoEl    = $("#videoPlayer");

  let clips = [];
  let checkoutItems = [];

  const gURL = id => `https://www.googleapis.com/drive/v3/files/${id}?alt=media&key=${API_KEY}`;

  if (API_KEY && FOLDER_ID) {
    try{
      const url=`https://www.googleapis.com/drive/v3/files?q='${FOLDER_ID}'+in+parents+and+mimeType='video/mp4'&fields=files(id,name)&pageSize=1000&key=${API_KEY}`;
      const j=await (await fetch(url)).json();
      clips=(j.files||[]).map(f=>({id:f.id,name:f.name.replace(/\.mp4$/i,"")}));
    }catch(e){
      console.warn("Drive API error", e);
    }
  }

  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const [{result}]=await chrome.scripting.executeScript({
      target:{tabId:tab.id},
      func:()=>Array.from(document.querySelectorAll('a[href*="wco?method=resource"]')).map(a=>a.textContent.trim())
    });
    checkoutItems=(result||[]).filter(Boolean);
  }catch{ checkoutItems=[]; }

  (() => {
    sBox.innerHTML=""; const added=new Set();
    clips.forEach(c=>{
      const toks=c.name.toLowerCase().split(/[^a-z0-9]+/).filter(t=>t.length>=3);
      if(!toks.length) return;
      const match=checkoutItems.some(it=>toks.every(t=>it.toLowerCase().includes(t)));
      if(match&&!added.has(c.id)){
        const d=document.createElement("div");
        d.textContent=c.name;
        d.onclick=()=>{videoInput.value=c.name;aList.innerHTML="";};
        sBox.appendChild(d);
        added.add(c.id);
      }
    });
  })();

  videoInput.oninput = () => {
    const v=videoInput.value.toLowerCase();
    aList.innerHTML="";
    if(!v) return;
    clips.filter(c=>c.name.toLowerCase().includes(v)).slice(0,6).forEach(c=>{
      const d=document.createElement("div");
      d.textContent=c.name;
      d.onclick=()=>{videoInput.value=c.name;aList.innerHTML="";};
      aList.appendChild(d);
    });
  };

  playBtn.onclick = () => {
    if(!API_KEY){ alert("secret.json missing API_KEY/FOLDER_ID"); return; }
    const name=videoInput.value.trim().toLowerCase();
    const c=clips.find(x=>x.name.toLowerCase()===name);
    if(!c){ alert("Video not found."); return; }
    videoEl.src=gURL(c.id);
    videoEl.style.display="block";
    videoEl.play();
  };
})();
/* popup.js – S.T.A.R Lab Tools (Late Fee + Video Search only)
 * - Signatures tab and native messaging code removed
 */

(async () => {

  /* --------------------------------------------------------- *
   * Helpers
   * --------------------------------------------------------- */
  const $  = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  async function getJSON(url){
    const r = await fetch(url);
    if(!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
  }

  /* --------------------------------------------------------- *
   * Tab switching
   * --------------------------------------------------------- */
  $$(".tab").forEach(tab => {
    tab.onclick = () => {
      $$(".tab").forEach(t => t.classList.remove("active"));
      $$(".content-section").forEach(s => s.classList.remove("active"));
      tab.classList.add("active");
      $("#"+tab.dataset.tab).classList.add("active");
    };
  });

  /* --------------------------------------------------------- *
   * Late-Fee Calculator
   * --------------------------------------------------------- */
  const DEFAULT_RATE  = 5;
  const DEFAULT_HOURS = [
    null, [12,0,18,0], [12,0,18,0], [12,0,18,0],
          [12,0,18,0], [12,0,18,0], null
  ];
  const HOUR_MS = 36e5;
  const dayName = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const pad   = n => String(n).padStart(2,"0");
  const hhmm  = (h,m)=>`${pad(h)}:${pad(m)}`;

  const rateEl     = $("#rate");
  const saveEl     = $("#save");
  const calcEl     = $("#calc");
  const resultEl   = $("#result");
  const manualChk  = $("#manualChk");
  const manualWrap = $("#manualInputs");

  // manual inputs hidden by default
  manualWrap.style.display = "none";
  manualChk.addEventListener("change", () => {
    manualWrap.style.display = manualChk.checked ? "block" : "none";
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

  // Fee algorithm with fix: don't charge when exactly at close
  function calcFee(due,ret,{rate,hours}){
    let fee=0,t=new Date(due);
    while(t<ret){
      const idx=t.getDay(),sched=hours[idx];
      if(!sched){
        fee+=rate;
        t.setDate(t.getDate()+1);
        t.setHours(0,0,0,0);
        continue;
      }

      const [oh,om,ch,cm]=sched,
            open =new Date(t),
            close=new Date(t);
      open .setHours(oh,om,0,0);
      close.setHours(ch,cm,0,0);

      if(t<open){ t=open; continue; }

      if(t>=close){
        if(t>close) fee+=rate;      // <-- only charge if actually past close
        t.setDate(t.getDate()+1);
        t.setHours(0,0,0,0);
        continue;
      }

      const segEnd = Math.min(close, ret),
            diff   = segEnd - t,
            full   = Math.floor(diff / HOUR_MS);

      if(full>0){
        fee += full * rate;
        t = new Date(t.getTime() + full * HOUR_MS);
        continue;
      }
      // any remainder within open hours rounds up to 1 hour
      fee += rate;
      t = close;
    }
    return fee;
  }

  const cfg0 = await loadCFG();
  rateEl.value = cfg0.rate  ?? DEFAULT_RATE;
  buildTable   (cfg0.hours ?? DEFAULT_HOURS);

  saveEl.onclick = async () => {
    await saveCFG({ rate:+rateEl.value||DEFAULT_RATE, hours:readTable() });
    const msg=$("#saveMsg");
    msg.textContent="✔ Saved"; setTimeout(()=>msg.textContent="",2000);
  };

  async function scrapeTimes(){
    try{
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      const [{result}]=await chrome.scripting.executeScript({
        target:{tabId:tab.id},
        func:()=>({
          due:document.querySelector('span[id$=".scheduledEndTime.valueLabel"]')?.textContent.trim(),
          ret:document.querySelector('span[id$=".realEndTime.valueLabel"]')?.textContent.trim()
        })
      });
      if(!result?.due || !result?.ret) return null;
      const d=new Date(result.due), r=new Date(result.ret);
      return (isNaN(d)||isNaN(r))?null:{due:d,ret:r};
    }catch{
      return null;
    }
  }

  calcEl.onclick = async () => {
    resultEl.textContent="";
    const manual = $("#manualChk").checked;
    let times;

    if(manual){
      const dStr=$("#manualDue").value, rStr=$("#manualRet").value;
      if(!dStr||!rStr){ resultEl.textContent="⚠️ Enter both dates."; return; }
      times={due:new Date(dStr),ret:new Date(rStr)};
      if(isNaN(times.due)||isNaN(times.ret)){ resultEl.textContent="⚠️ Invalid date."; return; }
    }else{
      times = await scrapeTimes();
      if(!times){ resultEl.textContent="⚠️ Timestamps not found."; return; }
    }

    const cfg = await loadCFG();
    const fee = calcFee(times.due, times.ret, {
      rate : cfg.rate  ?? DEFAULT_RATE,
      hours: cfg.hours ?? DEFAULT_HOURS
    });
    resultEl.textContent = `Late Fee: $${fee}`;
  };

  /* --------------------------------------------------------- *
   * Google Drive Video Search
   * --------------------------------------------------------- */
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

  // load video list (optional)
  if (API_KEY && FOLDER_ID) {
    try{
      const url=`https://www.googleapis.com/drive/v3/files?q='${FOLDER_ID}'+in+parents+and+mimeType='video/mp4'&fields=files(id,name)&pageSize=1000&key=${API_KEY}`;
      const j=await (await fetch(url)).json();
      clips=(j.files||[]).map(f=>({id:f.id,name:f.name.replace(/\.mp4$/i,"")}));
    }catch(e){
      console.warn("Drive API error", e);
    }
  }

  // scrape item names to suggest
  try{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const [{result}]=await chrome.scripting.executeScript({
      target:{tabId:tab.id},
      func:()=>Array.from(document.querySelectorAll('a[href*="wco?method=resource"]')).map(a=>a.textContent.trim())
    });
    checkoutItems=(result||[]).filter(Boolean);
  }catch{ checkoutItems=[]; }

  // suggestions
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

  // autocomplete
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

  // play
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
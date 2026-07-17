const fs = require("fs");
const { JSDOM, VirtualConsole } = require("jsdom");
let htmlRaw = fs.readFileSync("index.html", "utf-8");
htmlRaw = htmlRaw.replace(/<script src="https:\/\/cdn\.tailwindcss\.com[^>]*><\/script>/g, "");
htmlRaw = htmlRaw.replace(/<script id="tailwind-config">[\s\S]*?<\/script>/g, "");
htmlRaw = htmlRaw.replace(/<script src="https:\/\/[^"]+"><\/script>/g, "");
const appJs = fs.readFileSync("app.js", "utf-8");
htmlRaw = htmlRaw.replace(/<script src="app\.js"><\/script>/, "<script>" + appJs + "</script>");
const scheduleHtml = '<!DOCTYPE HTML><html><head><meta charset="windows-1251"></head><body class="general"><div id="content"><div class="inlnBlck"><table cellspacing="1" id="sched"><tr><td colspan="5" class="wday">понедельник</td></tr><tr><td rowspan="1">8:15-9:35</td><td rowspan="1">(1-10)</td><td colspan="3">Математика <span class="distype">(Лекции)</span></td><td class="right">1/100</td></tr></table></div></div></body></html>';
const primaryLessons = [{ day:"понедельник", time:"8:15-9:35", weeks:"(1-10)", subject:"Математика", _subjectOrderIndex:1 }];
const store = {};
store["bseu_primary_group"] = JSON.stringify({ faculty:"12", form:"10", course:"1", group:"9820" });
store["bseu_primary_group_lessons"] = JSON.stringify(primaryLessons);
store["bseu_semester_start_date"] = new Date("Mon Jul 13 00:00:00 UTC+0300 2026").toISOString();
store["shifts"] = JSON.stringify([{ id:"1", date:"2026-07-20", jobId:"1", startTime:"9:00", endTime:"12:00" }]);
const vc = new VirtualConsole();
vc.on("jsdomError", e => console.log("JSDOM ERR:", e.message));
vc.on("log", (...a) => console.log("PAGE LOG:", ...a));
vc.on("error", (...a) => console.log("PAGE ERR:", ...a));
const dom = new JSDOM(htmlRaw, { runScripts:"dangerously", pretendToBeVisual:true, url:"http://localhost:3000/", virtualConsole:vc,
  beforeParse(window){
    window.matchMedia = q => ({ matches:false, media:q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
    window.localStorage = { getItem:k=>(k in store?store[k]:null), setItem:(k,v)=>{store[k]=String(v)}, removeItem:k=>{delete store[k]} };
    window.fetch = async (url,opts)=>{ let body=""; if(opts&&opts.body){ try{body=JSON.parse(opts.body).body||"";}catch(e){body=opts.body;} }
      let resp = body.includes("schedule")?scheduleHtml:"[]";
      return { ok:true, status:200, text:async()=>resp, arrayBuffer:async()=>new TextEncoder().encode(resp).buffer, json:async()=>JSON.parse(resp) }; };
  }});
const { window } = dom;
setTimeout(()=>{
  try {
    console.log("typeof updateIntersectionAlerts:", typeof window.updateIntersectionAlerts);
    window.updateIntersectionAlerts();
    const toggle = window.document.getElementById("income-toggle");
    const dot = window.document.getElementById("income-dot");
    console.log("income-blink present:", toggle.classList.contains("income-blink"));
    console.log("dot hidden:", dot.classList.contains("hidden"));
  } catch(e){ console.log("ERR", e.message, e.stack); }
}, 5000);

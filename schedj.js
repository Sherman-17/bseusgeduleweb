var selStr='выберите...';
function asgEvnt(tg, evnt, hndlr) {
	if (tg.attachEvent) 
		tg.attachEvent ('on' + evnt, hndlr)
	else if (tg.addEventListener)
		tg.addEventListener (evnt, hndlr, false)
}
function xmlHttpObject(stHlr,sUrl,rPrms) {
	var oHttp;
 	if(window.XMLHttpRequest){
		oHttp = new XMLHttpRequest(  );
    } else if (window.ActiveXObject){
        oHttp=new ActiveXObject("Msxml2.XMLHTTP");
        if (!oHttp){
            oHttp=new ActiveXObject("Microsoft.XMLHTTP");
        }
    }
	oHttp.onreadystatechange=function(){stHlr(oHttp)}; //xmlHttpOnstateChange;
	oHttp.open('post',sUrl,true);
    oHttp.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
	oHttp.send(rPrms);	
}
function absTop(o){
	var rslt=0;
	while(o.nodeName!='BODY') {
		rslt+=o.offsetTop;
		o=o.offsetParent;		
	}
	return rslt;
}
function absLeft(o){
	var rslt=0;
	while(o.nodeName!='BODY') {
		rslt+=o.offsetLeft;
		o=o.offsetParent;		
	}
	return rslt;
}
// Submit Action object
// parameters:
// id - submit button's id 
// params - coma separated string with action parameters names
// actstr - action's "__act" field value
function SubmtActn(id,params,actstr) {
	// forms submit button
	this.sb=document.getElementById(id);
	// action's act field value
	this.AAStr=actstr;
	// action parameters
	this.params=params.split(',');
	// form object
	this.frm=this.ParentForm();
	// action hidden field
	this.actFld=this.ActionField();
	asgEvnt(this.sb,'click',function(){
		return document.getElementById('__act').value!=''})
}

SubmtActn.prototype.ParentForm=function(){
	if (this.sb) {
		var pn=this.sb.parentNode;
		while (pn.nodeName!='FORM')
			pn=pn.parentNode;
		return pn
	}
	else
		throw 'No submit button in the form';
}

SubmtActn.prototype.ActionField=function(){
	if(this.frm) {
		var af=this.frm.getElementsByTagName('input');
		for(var i=0;i<af.length&&af[i].name!='__act';i++) {}
		if(i<af.length)
			return af[i]
		else
			throw 'No action hidden field'
	}
	else
		throw 'No form';
}

SubmtActn.prototype.trimPrms=function(){
	if(this.AAStr)
		return this.AAStr.slice(this.AAStr.indexOf('__id.'))
	else
		throw 'No Action string';
}

SubmtActn.prototype.chState=function(v) {
	this.sb.disabled=v;
}

//assigns action value with parameters to "__act" input field
//n - xml nod attributes
//
SubmtActn.prototype.AsgnActn=function(na){
	var self=this;
	var rslt='';
	var p;
	var pv;
	for(var i=0;i<self.params.length;i++) {
		p=self.params[i];
		pv=na.constructor==Object?na[p]:na;
		rslt+=p+'.'+pv.length+'.'+pv;
	}
	self.actFld.value=rslt+self.trimPrms();
	self.chState(self.actFld.value=='');
}
SubmtActn.prototype.clearActn=function(){
	this.actFld.value='';
	this.chState(true);
}
/* Link used in combobox
	na - xml nodeattributes
	an - attributename of lnk value
     onClick copies key and text values to parent textbox and its hidden value field
*/
function AdvLnk(atb, na, an) {
	this.parent=atb;
	var o=this;
	var lnk=document.createElement('a');
	lnk.href='javascript:void(0)';
	lnk.innerHTML=na.constructor==Object?na[an]:na;
	asgEvnt(lnk,'click',function(){o.cp(o.parent);if(atb.keyAct)atb.keyAct.AsgnActn(na);atb.HideList()});
	atb.slLst.appendChild(lnk);
	atb.slLst.appendChild(document.createElement('br'));
	this.lnk=lnk
}

AdvLnk.prototype.cp=function(atb) {
	atb.ITB.value=this.lnk.innerHTML;
//	atb.HideList();
}
// Input textbox with dropdownlist loaded dynamically from webserver
// properties:
// act - action's "__act" field value, requesting values from server 
// attrName - xml nods attribute name with  dropdown list values
// keyAct - SubmActn object for wich AdvTB support key parameters
function AdvTB(id,attrName,act,keyAct) {
	var o=this; 
	this.attrName=attrName;
	this.actLinkValue=act; 
	this.keyAct=keyAct;
	this.params='__act='+act;
	this.slLst;
	this.oldValue;
	this.ITB=document.getElementById(id);
	this.clearValue=function(){o.ITB.value='';o.keyAct.clearActn()}
	this.ITB.rst=function(){o.clearValue()};
	this.lstActn=false;
//	this.ITB.clearValue==o.clearValue;
	this.fill=function(oHttp){
		if (oHttp.readyState==1) o.showMsg('Загружается...')
		else if (oHttp.readyState==4 && oHttp.status==200) {
			if (oHttp.responseText!=''){
				if(window.JSON)
					var r=JSON.parse(oHttp.responseText);
				else
					var r=eval(oHttp.responseText);
					
				if (r.constructor=Array) 
					o.showList(r);
				else
					o.showMsg('Ошибка: неизвестный формат');	
			}
			else 
				o.showMsg('Нет данных');
			oHttp.abort();
			oHttp = null;
		}
		else o.HideList();
	};
	asgEvnt(o.ITB,'keyup',function(e){
			if(o.ITB.value.length>2) {
				if(e.keyCode==8||e.keyCode>45)
					if(o.ITB.value==o.oldValue) o.ShLyr();
					else setTimeout(o.loadList.call(o),500);
			}
			else o.HideList()
		}
	);
	asgEvnt(o.ITB,'focus',function(e){
			if (o.ITB.value.length>2&&o.oldValue&&o.oldValue!='') o.ShLyr();
		}
	);
	asgEvnt(o.ITB,'blur',function(e){
//		if(o.ITB.value.length>2)o.loadTeachers();else 
//		o.timeout=setTimeout(function(){o.HideList()},200);
			if (!o.lstActn)o.HideList();
		}
	);
}
// function reads list of values from database
AdvTB.prototype.readList=function(n) {
	for(var i=0;i<n.length;i++) 
		new AdvLnk(this,n[i], this.attrName);
}
AdvTB.prototype.getParams=function(){
	return (this.params+'&'+this.ITB.id+'='+this.ITB.value)
}
AdvTB.prototype.loadList=function(){
	if (this.ITB.value.length>2&&this.oldValue!=this.ITB.value) {
		xmlHttpObject(this.fill,document.URL,this.getParams());
		this.oldValue=this.ITB.value;
	}
}
AdvTB.prototype.ShLyr=function(){
	var slLst;
	var o=this;
	if (this.slLst)
		slLst=this.slLst;
	else{
		slLst=document.createElement('div');
		slLst.id='selLst';
		this.slLst=slLst;
		document.body.appendChild(slLst);
asgEvnt(slLst,'mousedown',function(e){o.lstActn=true;});
asgEvnt(slLst,'mouseout',function(e){o.lstActn=false;});
	}
	slLst.style.top=absTop(this.ITB)+28+'px';
	slLst.style.left=absLeft(this.ITB)+6+'px';
	slLst.style.display='';
}
AdvTB.prototype.clearLyr=function(){
	this.slLst.innerHTML='';	
}
AdvTB.prototype.resizeLyr=function(){
	var top=absTop(this.ITB)+22;
	var slLst=this.slLst;
	if(top-document.body.scrollTop+slLst.offsetHeight>document.body.clientHeight)
		slLst.style.height=document.body.scrollTop+document.body.clientHeight-top-10+'px';
	else slLst.style.height='';
}
AdvTB.prototype.showMsg=function (t) {
	if (t!=''){
		this.ShLyr();
		this.clearLyr();
		this.slLst.innerHTML=t;
		this.resizeLyr();
	}
}
// function shows div with list of values from xml nods
AdvTB.prototype.showList=function(items) {
	this.ShLyr();
	this.clearLyr();
	if (items.length>0)
		this.readList(items);
	else
		this.slLst.innerHTML='Совпадений не найдено.';
	this.resizeLyr();

	if (this.slLst.innerHTML==''&&this.slLst.style.display!='none') 
		this.HideList();
}
AdvTB.prototype.HideList=function(){
	this.lstActn=false;
	if (this.slLst)
		this.slLst.style.display='none';
}
function AdvHid(id,depsbmt,params,actstr){
	var o=document.getElementById(id);
	this.htmlO=o;
	var self=this;
	
	this.slvSbt=new SubmtActn(depsbmt,params,actstr);
	this.chSbtState=function(){
		self.slvSbt.chState(self.htmlO.value=='')};
	this.asgnActn=function(act){
		self.htmlO.value=act;self.slvSbt.chState()};
	this.clearValue=function(){self.htmlO.value=''; self.chSbtState()};
	this.htmlO.clearValue=this.clearValue;
	self.clearValue();
}
/*
var oHttp = null;

var frm;
var atb;
*/
/*
function oHttpStateChng(l) {
	if (oHttp.readyState==1) 
		WtLst(l,'Загружается...')
	else if (oHttp.readyState==4 && oHttp.status==200) {
		oXml=oHttp.responseXML;
		oRoot=oXml.documentElement;
		// root node must by 'Datapacket'
		if (oRoot.nodeName=='DATAPACKET' && oRoot.hasChildNodes()) {
			var nods=oRoot.childNodes;
			// skip nodes upto 'Rowdata' node
			var i=0
			while (i<nods.length && nods[i].nodeName!='ROWDATA') 
				i++
			// iterate through rows nods
			if (nods[i].nodeName=='ROWDATA' && nods[i].hasChildNodes()) {
				nods=nods[i].childNodes;
				FillList(l,nods);
			}
			else
				WtLst(l,'не найдено');
		}
		else
			WL(l,'Нет данных');
		oHttp.abort();
		oHttp = null;
	}
}

function groupStChng() {
	oHttpStateChng(frm.group);
}
function formStChng() {
	oHttpStateChng(frm.form);
}
function courseStChng() {
	oHttpStateChng(frm.course);
}

function noHttpStateChng(tb) {
	if (oHttp.readyState==1) 
		tb.showMsg('Загружается...')
	else if (oHttp.readyState==4 && oHttp.status==200) {
		oXml=oHttp.responseXML;
		if (oXml.documentElement) {
			oRoot=oXml.documentElement;
			// root node must by 'Datapacket'
			if (oRoot.nodeName=='DATAPACKET' && oRoot.hasChildNodes()) {
				var nods=oRoot.childNodes;
				// skip nodes upto 'Rowdata' node
				var i=0
				while (i<nods.length && nods[i].nodeName!='ROWDATA') 
					i++
				// iterate through rows nods
				if (nods[i].nodeName=='ROWDATA' && nods[i].hasChildNodes()) {
					nods=nods[i].childNodes;
					tb.showList(nods);
				}
				else
					tb.showMsg('не найдено');
			}
			else
				tb.showMsg('Нет данных');
		}
		else
			tb.showMsg('Нет данных');				
		oHttp.abort();
		oHttp = null;
	}
}

function xmlHttpObject(stHlr,sUrl,rPrms) {
 	if(window.XMLHttpRequest){
		oHttp = new XMLHttpRequest(  );
    } else if (window.ActiveXObject){
        oHttp=new ActiveXObject("Msxml2.XMLHTTP");
        if (!oHttp){
            oHttp=new ActiveXObject("Microsoft.XMLHTTP");
        }
    }
	oHttp.onreadystatechange=stHlr; //xmlHttpOnstateChange;
	oHttp.open('post',sUrl,true);
    oHttp.setRequestHeader("Content-Type",
            "application/x-www-form-urlencoded; charset=UTF-8");
	oHttp.send(rPrms);	
}
function gForm(c) {
	frm=c.parentNode;
	while (frm.nodeName!='FORM')
		frm=frm.parentNode;
}
*/

//slave select object - loads options in response to onchange event of master element
//id - id of correspondend html select element
//master - master object
//url - url of corresponding request to fill form
function AdvSelect(id, url, master, txtName, vleName){
	var self=this;
	this.textName=txtName?txtName:'text';
	this.valueName=vleName?vleName:'value';
	this.htmlO=document.getElementById(id);
	this.htmlO.value=-1;
	this.master;
	this.qParams;
	this.action;
	this.advH;
	this.fill=function(oHttp){
		if (oHttp.readyState==1) self.WtLst('Загружается...')
		else if (oHttp.readyState==4 && oHttp.status==200) {
			if (oHttp.responseText!=''){
				if(window.JSON)
					var r=JSON.parse(oHttp.responseText);
				else
					var r=eval(oHttp.responseText);
					
				if (r.constructor=Array) 
					self.FillList(r);
				else
					self.WtLst('Ошибка: неизвестный формат');
			}
			else 
				self.WtLst('Нет данных');
			oHttp.abort();
			oHttp = null;
		}
//		else o.HideList();
		
	};
	this.WtLst=function(t) {
		if (self.htmlO.length>1) 
			self.htmlO.length=1
		else if (self.htmlO.length==0) 
			self.htmlO.appendChild(document.createElement('OPTION'),null);
		self.htmlO.options[0].text=t;
		self.htmlO.options[0].value='-1';
	}
	this.FillList=function(n) {
		self.WtLst(selStr);
		var op;
	
		for(var i=0;i<n.length;i++) {
			op=self.htmlO.appendChild(document.createElement('OPTION'),null);
			op.text=n[i].constructor==Object?n[i][self.textName]:n[i];
			op.value=n[i].constructor==Object?n[i][self.valueName]:i;
		}
	}
	this.loadList=function(){if(self.validate())xmlHttpObject(self.fill,document.URL,self.getParams());}
	this.init=function(){
		if(self.advH!=null&&self.action!=null&&self.htmlO.value!=-1)self.advH.asgnActn(self.action);else self.advH.clearValue();};
	asgEvnt(this.htmlO,'focus',function(){if (this.length==1) self.loadList()});
	if (master!=null) {
		this.master=master;
		asgEvnt(this.master.htmlO,'change',this.loadList);
	}
	if (url!=null)
		this.qParams='__act='+url;

}
AdvSelect.prototype.write=function(t){WtLst(t)};
AdvSelect.prototype.getParams=function(){
	var p='';
	var mstr=this.master;
	while (mstr!=null){
		p+='&'+mstr.htmlO.name+'='+mstr.htmlO.value;
		mstr=mstr.master;
	}
	return this.qParams+p;
}
AdvSelect.prototype.validate=function(){
	return (this.master!=null&&this.master.htmlO.value!=-1&&(this.master.master==null||this.master.validate()));
}
AdvSelect.prototype.asgnActn=function(advH,act){
	var self=this;
	this.action=act;
	this.advH=advH;
	this.htmlO.rst=function(){
		self.init()};
//	this.clear=function(){self.advH.clearValue()}
//	this.htmlO.clearValue=self.clear;
	asgEvnt(this.htmlO,'change',function(){
		advH.asgnActn(act)})
}
function absTop(o){
	var rslt=0;
	while(o.nodeName!='BODY') {
		rslt+=o.offsetTop;
		o=o.offsetParent;		
	}
	return rslt;
}
function absLeft(o){
	var rslt=0;
	while(o.nodeName!='BODY') {
		rslt+=o.offsetLeft;
		o=o.offsetParent;		
	}
	return rslt;
}

function shP() {
	for(var i=0; i<arguments.length;i++){
		var o=document.getElementById(arguments[i]);
		if (o)
			o.style.display=(o.style.display==''?'none':'');
	}
}

function AdvInp(id) {
	var o=document.getElementById(id);
	this.htmlO=o;
	return this;
}

AdvInp.prototype.chState=function(st){
	this.htmlO.disabled=!st;
}

//radio input with dependant text input. If radiobutton not checked text input is disabled
//id - id of radio element, depinpt - id of dependant text input
function AdvRadio(id, depinpt){
	var o=document.getElementById(id);
	this.htmlO=o;
	this.chldO=new AdvInp(depinpt);
	var self=this;
	this.chChldState=function(){
		self.chldO.chState(self.htmlO.checked);}
	self.chChldState();
	
	this.radioO=o.form.elements[o.name];
	for(var i=0;i<self.radioO.length;i++)
		asgEvnt(self.radioO[i],'click',function(){
				self.chChldState()});
	return this;
}

function aTab(ownr, id, tabid){
	this.owner=ownr;
	this.htmlO=document.getElementById(id);
	var self=this;
	asgEvnt(this.htmlO, 'click', function(){self.owner.Deactivate();self.Activate()});
	this.controls=new Array(document.getElementById(tabid));
}
// adds aditional controls 
//input params - comma separated list of controls ids
aTab.prototype.addCtrl=function(){
	var args=arguments[0];
	for (var i=1; i<args.length; i++)
		this.controls.push(document.getElementById(args[i]));
}
aTab.prototype.Active=function(){
	return this.controls[0].style.display!='none';
}
//function initialises  controls of activating tab and clears of closing tab
//n - tab controls; s - tab state: true means closing tab; false - opening;
function enblTab(n,s){
	for (var i=0;i<n.childNodes.length;i++)
		if (n.childNodes[i].nodeType==1) {
			if (/*!s&&*/n.childNodes[i].rst!=null)
				n.childNodes[i].rst();
			/*else
				if(s&&n.childNodes[i].clearValue!=null)
					n.childNodes[i].clearValue();
				*/else
					if (n.childNodes[i].childNodes.length>0)
						enblTab(n.childNodes[i],s)
		}
}

aTab.prototype.Activate=function(){
	this.htmlO.className+=' active';
	for (i=0; i<this.controls.length;i++) {
		enblTab(this.controls[i],this.Active());	
		if (this.controls[i].style.display=='none') 
			this.controls[i].style.display='';
	}
}

aTab.prototype.Deactivate=function(){
	this.htmlO.className=this.htmlO.className.replace(/\s?active/gi,'');
	for (i=0; i<this.controls.length;i++) {
//		enblTab(this.controls[i],this.Active());
		if (this.controls[i].style.display=='') 
			this.controls[i].style.display='none';
	}
}

//tabs object - a tags as tab headers
//input params - list of pairs 'a' tags ids and tab 'div'  ids;
function aTabs() {
	var self=this;
	this.names=new Array();
	this.thdrs=new Array();
	for (var i=0;i<arguments.length;i+=2) {
		this.names.push(arguments[i]);
		atab=new aTab(self,arguments[i],arguments[i+1]);
		this.thdrs.push(atab);
	}
	this.thdrs[0].htmlO.className='active';
}

aTabs.prototype.addCtrls=function(id){
	for (var i=0;i<this.names.length&&this.names[i]!=id;i++){}
	this.thdrs[i].addCtrl(arguments)
}

aTabs.prototype.Deactivate=function(){
	for(var i=0;i<this.thdrs.length;i++)
		if (this.thdrs[i].Active())
			this.thdrs[i].Deactivate();
}

// Server entry point (Node.js / Render). In the browser this block is skipped
// because `window` is defined; on the server we start an HTTP server that
// serves this file and listens on process.env.PORT as required by Render.
if (typeof window === 'undefined' && typeof require !== 'undefined') {
  const express = require('express');
  const path = require('path');
  const fs = require('fs');
  const iconv = require('iconv-lite');
  const cheerio = require('cheerio');
  const PORT = process.env.PORT || 3000;

  // Используем __dirname для надежного разрешения пути к auth-модулю
  const AUTH_MODULE_CANDIDATES = [
    path.join(__dirname, 'server', 'auth'),
    path.join(__dirname, '..', 'server', 'auth')
  ];

  var auth;
  for (var i = 0; i < AUTH_MODULE_CANDIDATES.length; i++) {
    try {
      auth = require(AUTH_MODULE_CANDIDATES[i]);
      console.log('[AUTH] Auth module loaded successfully from', AUTH_MODULE_CANDIDATES[i]);
      break;
    } catch (e) {
      console.error('[AUTH] Failed to load auth module from', AUTH_MODULE_CANDIDATES[i], ':', e.message);
    }
  }

  // Fallback search
  if (!auth) {
    try {
      var searchDir = __dirname;
      for (var depth = 0; depth < 5; depth++) {
        var parent = path.dirname(searchDir);
        var candidate = path.join(parent, 'server', 'auth');
        try {
          auth = require(candidate);
          console.log('[AUTH] Auth module found via filesystem search at', candidate);
          break;
        } catch (e3) {}
        searchDir = parent;
      }
    } catch (e4) {}
  }

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Cookie parser
  const COOKIE_NAME = 'bseu_session';
  app.use((req, res, next) => {
    const raw = req.headers.cookie || '';
    const cookies = {};
    raw.split(';').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx === -1) return;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) cookies[k] = decodeURIComponent(v);
    });
    req.cookies = cookies;
    res.cookie = (name, value, opts = {}) => {
      let str = `${name}=${encodeURIComponent(value)}`;
      if (opts.maxAge) str += `; Max-Age=${Math.floor(opts.maxAge / 1000)}`;
      str += '; Path=' + (opts.path || '/');
      if (opts.httpOnly) str += '; HttpOnly';
      if (opts.sameSite) str += `; SameSite=${opts.sameSite}`;
      res.setHeader('Set-Cookie', str);
    };
    res.clearCookie = (name, opts = {}) => {
      res.setHeader('Set-Cookie', `${name}=; Path=${opts.path || '/'}; Max-Age=0; HttpOnly`);
    };
    next();
  });

  // ===== File-based cache layer =====
  // Вместо БД кэш хранится в JSON-файлах внутри папки .cache/
  // (создаётся рядом с сервером). Каждая запись — отдельный файл,
  // названный по хэшу ключа. Это упрощает отладку и не требует SQLite.
  const CACHE_DIR = path.join(__dirname, '.cache');
  function ensureCacheDir() {
    try {
      if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch (e) {
      console.error('[FileCache] Cannot create cache dir:', e.message);
    }
  }
  ensureCacheDir();

  function cacheFilePath(key) {
    const safe = Buffer.from(key).toString('base64').replace(/[/+=]/g, '_');
    return path.join(CACHE_DIR, `${safe}.json`);
  }

  function fileGetCache(key) {
    try {
      const file = cacheFilePath(key);
      if (!fs.existsSync(file)) return null;
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw);
      return { value: parsed.value, updatedAt: parsed.updatedAt };
    } catch (e) {
      console.error('[FileCache] getCache error:', e.message);
      return null;
    }
  }

  function fileSetCache(key, value) {
    try {
      ensureCacheDir();
      const file = cacheFilePath(key);
      fs.writeFileSync(file, JSON.stringify({ value, updatedAt: Date.now() }), 'utf-8');
    } catch (e) {
      console.error('[FileCache] setCache error:', e.message);
    }
  }

  function getToken(req) {
    return req.cookies ? req.cookies[COOKIE_NAME] : null;
  }
  function sessionUser(req) {
    const token = getToken(req);
    return auth ? auth.getSession(token) : null;
  }
  function setSessionCookie(res, token) {
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 1000 * 60 * 60 * 24 * 30,
      path: '/'
    });
  }

  // Rate limiter
  const AUTH_RATE_LIMIT = 5;
  const AUTH_RATE_WINDOW = 60 * 1000;
  const authAttempts = new Map();
  function authRateLimited(ip) {
    const now = Date.now();
    const rec = authAttempts.get(ip);
    if (!rec || rec.resetAt < now) {
      authAttempts.set(ip, { count: 1, resetAt: now + AUTH_RATE_WINDOW });
      return false;
    }
    rec.count += 1;
    return rec.count > AUTH_RATE_LIMIT;
  }
  function guardAuth(req, res, next) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (authRateLimited(ip)) {
      return res.status(429).json({ error: 'Слишком много попыток. Попробуйте позже.' });
    }
    next();
  }

  // --- Auth endpoints ---
  app.post('/api/auth/register', guardAuth, (req, res) => {
    if (!auth) return res.status(500).json({ error: 'auth_disabled' });
    try {
      const { login, password } = req.body || {};
      const user = auth.registerUser(login, password);
      const token = auth.createSession(user.id, user.login);
      setSessionCookie(res, token);
      res.json({ ok: true, user: { login: user.login } });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/auth/login', guardAuth, (req, res) => {
    if (!auth) return res.status(500).json({ error: 'auth_disabled' });
    try {
      const { login, password } = req.body || {};
      const user = auth.verifyUser(login, password);
      if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });
      const token = auth.createSession(user.id, user.login);
      setSessionCookie(res, token);
      res.json({ ok: true, user: { login: user.login } });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    if (!auth) return res.status(500).json({ error: 'auth_disabled' });
    const token = getToken(req);
    auth.destroySession(token);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    if (!auth) return res.status(500).json({ error: 'auth_disabled' });
    const s = sessionUser(req);
    if (!s) return res.json({ ok: true, user: null });
    res.json({ ok: true, user: { login: s.login } });
  });

  app.delete('/api/auth/account', (req, res) => {
    if (!auth) return res.status(500).json({ error: 'auth_disabled' });
    const s = sessionUser(req);
    if (!s) return res.status(401).json({ error: 'Не авторизован' });
    auth.deleteUser(s.userId);
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/sync', (req, res) => {
    if (!auth) return res.status(500).json({ error: 'auth_disabled' });
    const s = sessionUser(req);
    if (!s) return res.status(401).json({ error: 'Не авторизован' });
    res.json({ ok: true, blocks: auth.getBlocks(s.userId) });
  });

  app.post('/api/sync', (req, res) => {
    if (!auth) return res.status(500).json({ error: 'auth_disabled' });
    const s = sessionUser(req);
    if (!s) return res.status(401).json({ error: 'Не авторизован' });
    const blocks = Array.isArray(req.body && req.body.blocks) ? req.body.blocks : [];
    const valid = blocks.filter(b => b && typeof b.kind === 'string' && typeof b.payload === 'string');
    const merged = auth.applyBlocks(s.userId, valid);
    res.json({ ok: true, blocks: merged });
  });

  // --- REST Dropdowns and Schedule endpoints ---
  
  function toWin1251Url(str) {
    const buf = iconv.encode(str, 'win1251');
    let out = '';
    for (let i = 0; i < buf.length; i++) {
      const byte = buf[i];
      if (byte === 0x20) {
        out += '%20';
      } else if ((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)) {
        out += String.fromCharCode(byte);
      } else {
        out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
      }
    }
    return out;
  }

  function decodeResponseBuffer(buffer, response) {
    const contentType = response.headers.get('content-type') || '';
    const charsetMatch = contentType.match(/charset=([^\s;]+)/i);
    let charset = charsetMatch ? charsetMatch[1].replace(/['"]/g, '').toLowerCase() : null;
    
    if (!charset) {
      const utf8Text = buffer.toString('utf-8');
      try {
        JSON.parse(utf8Text);
        charset = 'utf-8';
      } catch (e) {
        if (utf8Text.includes('\uFFFD') || /[\x80-\xFF]/.test(utf8Text)) {
          charset = 'windows-1251';
        } else {
          charset = 'utf-8';
        }
      }
    }
    
    return iconv.decode(buffer, charset);
  }

  async function fetchBseuList(action, params = {}) {
    const cacheKey = `list:${action}:${JSON.stringify(params)}`;
    const cached = fileGetCache(cacheKey);
    const now = Date.now();
    const listTTL = 24 * 60 * 60 * 1000; // 24 hours
    
    if (cached && (now - cached.updatedAt < listTTL)) {
      return cached.value;
    }

    const bodyParts = [`__act=${action}`];
    for (let key in params) {
      if (key === 'tname') {
        bodyParts.push(`${key}=${toWin1251Url(params[key])}`);
      } else {
        bodyParts.push(`${key}=${params[key]}`);
      }
    }
    const bodyString = bodyParts.join("&");

    try {
      const response = await fetch("https://bseu.by/schedule/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=windows-1251",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        body: iconv.encode(bodyString, 'win1251')
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      const decoded = decodeResponseBuffer(Buffer.from(buffer), response);
       const data = JSON.parse(decoded);
       fileSetCache(cacheKey, data);
       return data;
     } catch (error) {
       console.error(`[BSEU List] Failed for ${action}:`, error);
       if (cached) return cached.value;
       throw error;
     }
  }

  function parseScheduleHtml(html) {
    const $ = cheerio.load(html);
    const table = $('table').first();
    
    let semesterStartDate = null;
    let currentSemesterWeek = 1;
    
    const semesterMatch = html.match(/<!--(?:first|second)\s+semester=(.*?)-->/i);
    if (semesterMatch) {
      semesterStartDate = new Date(semesterMatch[1]);
    } else {
      const weekMatch = html.match(/Текущая\s+-\s+<strong>(\d+)<\/strong>\s+учебная\s+неделя/i);
      if (weekMatch) {
        const currentWeekNum = Number(weekMatch[1]);
        currentSemesterWeek = currentWeekNum;
        const today = new Date();
        const day = today.getDay();
        const diff = today.getDate() - day + (day === 0 ? -6 : 1);
        const todayMonday = new Date(today.setDate(diff));
        todayMonday.setHours(0, 0, 0, 0);
        semesterStartDate = new Date(todayMonday.getTime() - (currentWeekNum - 1) * 7 * 24 * 60 * 60 * 1000);
      } else {
        semesterStartDate = new Date();
        currentSemesterWeek = 1;
      }
    }
    
    if (!table.length) {
      return { semesterStartDate, currentSemesterWeek, lessons: [] };
    }
    
    const rows = table.find('tr');
    let currentDay = '';
    const lessons = [];
    
    const headers = [];
    table.find('thead th').each((idx, th) => {
      headers.push($(th).text().trim().toLowerCase());
    });
    const isTeacherSchedule = headers.includes('группа');
    
    const rowArr = rows.toArray();
    for (let i = 0; i < rowArr.length; i++) {
      const row = $(rowArr[i]);
      const wdayCell = row.find('td.wday');
      if (wdayCell.length) {
        currentDay = wdayCell.text().trim();
        continue;
      }
      
      const cells = row.find('td');
      if (cells.length >= 3) {
        if (isTeacherSchedule) {
          if (cells.length >= 5) {
            const time = $(cells[0]).text().trim();
            const group = $(cells[1]).text().trim();
            const subgroup = $(cells[2]).text().trim();
            const contentCell = $(cells[3]);
            const room = $(cells[4]).text().trim();
            
            const distypeSpan = contentCell.find('.distype');
            const type = distypeSpan.length ? distypeSpan.text().replace(/[()]/g, '').trim() : '';
            
            const emEl = contentCell.find('em');
            const subject = emEl.length ? emEl.text().trim() : '';
            
            let weeks = '';
            const clone = contentCell.clone();
            clone.find('.distype').remove();
            clone.find('em').remove();
            const rawText = clone.text().trim();
            const match = rawText.match(/^\(([^)]+)\)/);
            if (match) {
              weeks = match[1];
            } else {
              weeks = rawText;
            }
            
            const displayGroup = subgroup ? `${group} (${subgroup})` : group;
            if (subject && time) {
              lessons.push({
                day: currentDay || "Вне сетки",
                time,
                weeks,
                subject,
                type,
                teacher: displayGroup,
                room,
                isTeacher: true
              });
            }
          }
        } else {
          const time = $(cells[0]).text().trim();
          const weeks = $(cells[1]).text().trim();
          let subject = '';
          let type = '';
          let teacher = '';
          let room = '';
          
          const contentCell = row.find("td[colspan='2'], td[colspan='3']");
          const rightCell = row.find('td.right, td.rght');
          
          if (contentCell.length) {
            const distypeSpan = contentCell.find('.distype');
            type = distypeSpan.length ? distypeSpan.text().replace(/[()]/g, '').trim() : '';
            
            const teacherSpan = contentCell.find('.teacher, .teacher.dd');
            teacher = teacherSpan.length ? teacherSpan.text().trim() : '';
            
            const clone = contentCell.clone();
            clone.find('.distype').remove();
            clone.find('.teacher, .teacher.dd').remove();
            subject = clone.text().replace(/,\s*$/, '').trim();
          }
          
          if (rightCell.length) {
            room = rightCell.text().trim();
          } else if (subject) {
            const subgroupRooms = [];
            for (let j = i + 1; j < rowArr.length; j++) {
              const subRow = $(rowArr[j]);
              if (subRow.find('td.wday').length) break;
              const subCells = subRow.find('td');
              if (subCells.length >= 3 && !subRow.find('td.sg').length) break;
              const lastCell = subCells.last();
              if (lastCell.length) {
                const r = lastCell.text().replace(/<!--[\s\S]*?-->/g, '').trim();
                if (r && !subgroupRooms.includes(r)) subgroupRooms.push(r);
              }
            }
            room = subgroupRooms.join(', ');
          }
          
          if (subject && time) {
            lessons.push({
              day: currentDay || "Вне сетки",
              time,
              weeks,
              subject,
              type,
              teacher,
              room,
              isTeacher: false
            });
          }
        }
      }
    }
    
    const subjectGroups = {};
    lessons.forEach(l => {
      const subj = (l.subject || '').trim();
      if (!subjectGroups[subj]) subjectGroups[subj] = [];
      subjectGroups[subj].push(l);
    });
    
    Object.values(subjectGroups).forEach(group => {
      const dayOrder = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
      group.sort((a, b) => {
        const aDay = (a.day || '').toLowerCase().trim();
        const bDay = (b.day || '').toLowerCase().trim();
        const aDayIdx = dayOrder.indexOf(aDay);
        const bDayIdx = dayOrder.indexOf(bDay);
        if (aDayIdx !== bDayIdx) return aDayIdx - bDayIdx;
        const aTime = a.time || '';
        const bTime = b.time || '';
        return aTime.localeCompare(bTime);
      });
      group.forEach((l, idx) => {
        l._subjectOrderIndex = idx + 1;
      });
    });
    
    return {
      semesterStartDate,
      currentSemesterWeek,
      lessons
    };
  }

  async function getScheduleWithCache(cacheKey, bodyString) {
    const cached = fileGetCache(cacheKey);
    const now = Date.now();
    const cacheTTL = 2 * 60 * 60 * 1000; // 2 hours
    
    if (cached && (now - cached.updatedAt < cacheTTL)) {
      return { ...cached.value, isFallback: false };
    }
    
    try {
      const response = await fetch("https://bseu.by/schedule/", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=windows-1251",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        },
        body: iconv.encode(bodyString, 'win1251')
      });
      
      if (!response.ok) throw new Error(`HTTP status ${response.status}`);
      const buffer = await response.arrayBuffer();
      const htmlText = decodeResponseBuffer(Buffer.from(buffer), response);
      
       const parsedData = parseScheduleHtml(htmlText);
       fileSetCache(cacheKey, parsedData);
       return { ...parsedData, isFallback: false };
    } catch (error) {
      console.error(`[BSEU Schedule] Failed for ${cacheKey}:`, error);
      if (cached) {
        return {
          ...cached.value,
          isFallback: true,
          savedAt: cached.updatedAt
        };
      }
      throw error;
    }
  }

app.get('/api/forms', async (req, res) => {
    try {
      const { faculty } = req.query;
      const data = await fetchBseuList("__id.22.main.inpFldsA.GetForms", { faculty });
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  app.get('/api/courses', async (req, res) => {
    try {
      const { faculty, form } = req.query;
      const data = await fetchBseuList("__id.23.main.inpFldsA.GetCourse", { faculty, form });
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  app.get('/api/groups', async (req, res) => {
    try {
      const { faculty, form, course } = req.query;
      const data = await fetchBseuList("__id.23.main.inpFldsA.GetGroups", { faculty, form, course });
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  app.get('/api/teachers', async (req, res) => {
    try {
      const { q } = req.query;
      const data = await fetchBseuList("__id.24.main.TSchedA.getTeachers", { tname: q });
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ===== Unified schedule endpoint =====
  // Принимает query-параметры:
  //   - Расписание группы: faculty, form, course, group
  //   - Расписание преподавателя: tid, taid, sid, tname
  //   - Расписание аудитории: audience, date
  // Старые пути /api/schedule/group и /api/schedule/teacher перенаправляются
  // сюда же для обратной совместимости.
  async function handleScheduleRequest(req, res) {
    try {
      const { faculty, form, course, group, tid, taid, sid, tname, audience, date } = req.query;

      // Режим аудитории (агрегация по API BSEU)
      if (audience && date) {
        const schedule = await getAudienceScheduleBseu((audience || '').trim(), (date || '').trim());
        return res.json(schedule);
      }

      // Режим преподавателя (источник bseu.by)
      if (tid && taid && sid && tname) {
        const body = `__act=tid.${tid.length}.${tid}taid.${taid.length}.${taid}sid.${sid.length}.${sid}__id.22.main.TSchedA.GetTSched__sp.8.tresults__fp.4.main&tname=${tname}&period=3`;
        const cacheKey = `teacher:${tid}:${taid}:${sid}:${tname}`;
        const schedule = await getScheduleWithCache(cacheKey, body);
        return res.json(schedule);
      }

      // Режим группы (источник bseu.by)
      if (faculty && form && course && group) {
        const body = `__act=__id.25.main.inpFldsA.GetSchedule__sp.7.results__fp.4.main&faculty=${faculty}&form=${form}&course=${course}&group=${group}&period=3`;
        const cacheKey = `group:${faculty}:${form}:${course}:${group}`;
        const schedule = await getScheduleWithCache(cacheKey, body);
        return res.json(schedule);
      }

      return res.status(400).json({ error: 'missing_params', received: req.query });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  app.get('/api/schedule', handleScheduleRequest);
  // Обратная совместимость со старыми путями
  app.get('/api/schedule/group', handleScheduleRequest);
  app.get('/api/schedule/teacher', handleScheduleRequest);
  app.get('/api/schedule/room', handleScheduleRequest);

  // --- Список аудиторий для автодополнения (из полной копии расписания) ---
  // Возвращаем полные строки аудиторий (например "2/301", "4/301"), как они
  // хранятся в BSEU. Фильтрация по q идёт по нормализованным токенам
  // (числам после слэша), чтобы ввод "301" находил "2/301" и "4/301".
  app.get('/api/audiences', async (req, res) => {
    try {
      const q = (req.query.q || '').trim().toLowerCase();
      const schedule = await ensureFullSchedule();
      
      // Если кэш ещё не готов
      if (!schedule && !fullScheduleCache) {
        if (!fullScheduleBuilding) {
          buildFullSchedule().catch(e => console.error('[FullSchedule] Фоновая сборка:', e.message));
        }
        return res.status(503).json({ 
          error: 'building', 
          message: 'Идёт первичная загрузка расписания аудиторий. Попробуйте через минуту.',
          building: true 
        });
      }
      
      const src = schedule || fullScheduleCache || [];
      const map = new Map();
      for (const p of src) {
        const full = p.audience;
        if (!full) continue;
        // Разделяем строку аудиторий по запятым и обрабатываем каждую отдельно
        const roomParts = String(full).trim().split(',').map(r => r.trim());
        // Проверяем, что все части содержат цифры (фильтруем фамилии преподавателей)
        const allValid = roomParts.every(part => /\d/.test(part.trim()));
        if (!allValid) continue;
        // Добавляем каждую аудиторию отдельно в список
        for (const room of roomParts) {
          // Для фильтрации по q проверяем полную аудиторию
          if (q) {
            // Проверяем, что строка поиска содержится в аудитории
            // (например, "2" найдет "2/301", "301" найдет "2/301", "2/301" найдет "2/301")
            if (!room.toLowerCase().includes(q)) continue;
          }
          map.set(room, (map.get(room) || 0) + 1);
        }
      }
      const list = Array.from(map.entries())
        .map(([audience, count]) => ({ audience, count }))
        .sort((a, b) => {
          const na = Number(a.audience.replace(/\D/g, '')) || 0;
          const nb = Number(b.audience.replace(/\D/g, '')) || 0;
          return na - nb || a.audience.localeCompare(b.audience);
        });
      res.json(list);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- Расписание аудитории на основе API BSEU ---
  // ===== Полная копия всего расписания БГЭУ на сервере =====
  // У BSEU нет прямого API по аудитории. Поэтому сервер периодически
  // (каждые 10 минут) собирает расписания ВСЕХ групп всех факультетов в
  // единую копию (fullScheduleCache). При запросе аудитории мы лишь
  // фильтруем эту уже готовую копию — без обращения к BSEU в момент запроса.

  const BSEU_FACULTIES = [
    "12", "14", "13", "7", "2", "8", "534", "11", "263", "18",
    "129", "450", "530", "531", "497", "535", "432"
  ];
  const FULL_SCHEDULE_INTERVAL = 30 * 60 * 1000; // 30 минут

  // In-memory полная копия расписания: массив пар вида
  // { audience, audienceTokens:[...], dates:[...], subject, type, teacher, groupText, startTime, endTime }
  let fullScheduleCache = null;
  let fullScheduleUpdatedAt = 0;
  let fullScheduleBuilding = false;
  let fullSchedulePromise = null;
  let fullScheduleError = null;
  let fullScheduleStartedAt = 0;

  // Кэш расписания по аудиториям: { "2/301": [{ subject, type, teacher, groupText, startTime, endTime, dates, audience, audienceTokens }, ...] }
  let audienceScheduleCache = {};
  let audienceScheduleUpdatedAt = 0;

  // --- Загрузка кэша из файла (если есть) ---
  const CACHE_FILE = path.join(__dirname, 'fullScheduleCache.json');
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const cachedData = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      fullScheduleCache = cachedData.fullScheduleCache || null;
      fullScheduleUpdatedAt = cachedData.updatedAt || 0;
      audienceScheduleCache = cachedData.audienceScheduleCache || {};
      audienceScheduleUpdatedAt = cachedData.audienceScheduleUpdatedAt || 0;
      console.log('[Cache] Загружен кэш из файла:', CACHE_FILE);
    }
  } catch (e) {
    console.warn('[Cache] Не удалось загрузить кэш из файла:', e.message);
  }
  
  // ===== Improved fetch with timeout =====
  const FETCH_TIMEOUT = 15000;
  async function fetchWithTimeout(url, options = {}, timeout = FETCH_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      return response;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`Request timed out after ${timeout}ms: ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  
  // ===== Health check endpoint для Render =====
  app.get('/api/status', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      fullSchedule: {
        hasCache: !!fullScheduleCache,
        entries: fullScheduleCache ? fullScheduleCache.length : 0,
        building: fullScheduleBuilding,
        updatedAt: fullScheduleUpdatedAt,
        startedAt: fullScheduleStartedAt,
        error: fullScheduleError,
        buildingTime: fullScheduleStartedAt ? Math.floor((Date.now() - fullScheduleStartedAt) / 1000) + 's' : null
      },
      nodeVersion: process.version,
      timestamp: Date.now()
    });
  });

  // Получить все группы факультета (каскад форма -> курс -> группа)
  async function getFacultyGroups(faculty) {
    const forms = await fetchBseuList("__id.22.main.inpFldsA.GetForms", { faculty });
    if (!Array.isArray(forms)) return [];
    let groups = [];
    for (const f of forms) {
      const courses = await fetchBseuList("__id.23.main.inpFldsA.GetCourse", { faculty, form: f.value });
      if (!Array.isArray(courses)) continue;
      for (const c of courses) {
        const gs = await fetchBseuList("__id.23.main.inpFldsA.GetGroups", { faculty, form: f.value, course: c.value });
        if (!Array.isArray(gs)) continue;
        for (const g of gs) {
          groups.push({ faculty, form: f.value, course: c.value, group: g.value, groupText: g.text });
        }
      }
    }
    return groups;
  }

  // Дата конкретной пары от старта семестра (аналог getDateForLesson на клиенте)
  function lessonDate(semesterStartDate, dayName, weekNum) {
    if (!semesterStartDate || !weekNum) return null;
    const daysOfWeekMap = {
      'понедельник': 0, 'вторник': 1, 'среда': 2, 'четверг': 3,
      'пятница': 4, 'суббота': 5, 'воскресенье': 6
    };
    const dayIndex = daysOfWeekMap[String(dayName || '').toLowerCase().trim()];
    if (dayIndex === undefined) return null;
    const start = new Date(semesterStartDate);
    const monday = new Date(start);
    const sd = monday.getDay();
    monday.setDate(monday.getDate() - (sd === 0 ? 6 : sd - 1));
    monday.setHours(0, 0, 0, 0);
    const result = new Date(monday);
    result.setDate(monday.getDate() + (weekNum - 1) * 7 + dayIndex);
    const y = result.getFullYear();
    const m = String(result.getMonth() + 1).padStart(2, '0');
    const d = String(result.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseWeeks(weeksStr) {
    if (!weeksStr) return [];
    const clean = String(weeksStr).replace(/[()]/g, '').trim();
    if (!clean) return [];
    const result = [];
    clean.split(',').forEach(part => {
      if (part.includes('-')) {
        const [s, e] = part.split('-').map(Number);
        for (let i = s; i <= e; i++) result.push(i);
      } else {
        const n = Number(part);
        if (!Number.isNaN(n)) result.push(n);
      }
    });
    return result;
  }

  // Нормализация номера аудитории. BSEU хранит их как "2/301, 2/406"
  // (корпус/номер), иногда просто "301". Извлекаем все числовые сегменты
  // после слэша (либо сам номер), чтобы сравнивать с введённым.
  function audienceTokens(room) {
    if (!room) return [];
    const tokens = [];
    String(room).split(',').forEach(part => {
      const p = part.trim();
      const slashIdx = p.lastIndexOf('/');
      const num = (slashIdx >= 0 ? p.slice(slashIdx + 1) : p).trim();
      const m = num.match(/^\d+/);
      if (m) tokens.push(m[0]);
    });
    return tokens;
  }

  // Собрать полную копию расписания всех групп всех факультетов.
  // Возвращает массив пар, каждая с готовыми датами (strings) и токенами аудитории.
  async function buildFullSchedule() {
    if (fullScheduleBuilding) return fullSchedulePromise;
    fullScheduleBuilding = true;
    fullScheduleError = null;
    fullScheduleStartedAt = Date.now();
    fullSchedulePromise = (async () => {
      console.log('[FullSchedule] Начинаем сборку полной копии расписания...');
      const t0 = Date.now();

      // 1. Собрать все группы всех факультетов параллельно (allSettled)
      let allGroups = [];
      const groupResults = await Promise.allSettled(BSEU_FACULTIES.map(fac =>
        getFacultyGroups(fac).catch(e => {
          console.warn(`[FullSchedule] Факультет ${fac}: ${e.message}`);
          return [];
        })
      ));
      groupResults.forEach(result => {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
          allGroups = allGroups.concat(result.value);
        }
      });

      // 2. Загрузить расписания групп параллельно пачками и развернуть пары по датам
      const CONCURRENCY = 15;
      const all = [];
      if (allGroups.length > 0) {
        for (let i = 0; i < allGroups.length; i += CONCURRENCY) {
          const batch = allGroups.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(batch.map(async (g) => {
            try {
              const body = `__act=__id.25.main.inpFldsA.GetSchedule__sp.7.results__fp.4.main&faculty=${g.faculty}&form=${g.form}&course=${g.course}&group=${g.group}&period=3`;
              const gkey = `group:${g.faculty}:${g.form}:${g.course}:${g.group}`;
              const sched = await getScheduleWithCache(gkey, body);
              return { sched, g };
            } catch (e) {
              return null;
            }
          }));
          for (const r of results) {
            if (r.status !== 'fulfilled' || !r.value) continue;
            const { sched, g } = r.value;
            const lessons = sched.lessons || [];
            const semStart = sched.semesterStartDate;
            for (const l of lessons) {
              const weeks = parseWeeks(l.weeks);
              const dates = [];
              for (const w of weeks) {
                const d = lessonDate(semStart, l.day, w);
                if (d) dates.push(d);
              }
              if (!dates.length) continue;
              if (!l.room) continue;
              const roomStr = String(l.room).trim();
              const roomParts = roomStr.split(',').map(p => p.trim());
              const allValid = roomParts.every(part => /\d/.test(part));
              if (!allValid) continue;
              const [start, end] = String(l.time || '').split(/[-–]/).map(s => s.trim());
              const entry = {
                audience: l.room,
                audienceTokens: audienceTokens(l.room),
                dates,
                subject: l.subject,
                type: l.type,
                teacher: l.teacher || '',
                groupText: g.groupText,
                startTime: start || '',
                endTime: end || ''
              };
              all.push(entry);
              
              if (l.room) {
                if (!audienceScheduleCache[l.room]) {
                  audienceScheduleCache[l.room] = [];
                }
                audienceScheduleCache[l.room].push(entry);
              }
            }
          }
          // Небольшая задержка между батчами
          if (i + CONCURRENCY < allGroups.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }

      fullScheduleCache = all;
      fullScheduleUpdatedAt = Date.now();
      audienceScheduleUpdatedAt = Date.now();
      fullScheduleError = null;
      
      // Сохраняем кэш в файл для последующего использования
      try {
        fs.writeFileSync(CACHE_FILE, JSON.stringify({
          fullScheduleCache,
          audienceScheduleCache,
          updatedAt: fullScheduleUpdatedAt,
          audienceScheduleUpdatedAt
        }, null, 2));
        console.log('[Cache] Кэш сохранён в файл:', CACHE_FILE);
      } catch (e) {
        console.warn('[Cache] Не удалось сохранить кэш в файл:', e.message);
      }
      
      console.log(`[FullSchedule] Готово: ${all.length} пар, ${allGroups.length} групп, за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
      fullScheduleBuilding = false;
      return all;
    })();
    fullSchedulePromise.catch(e => {
      console.error('[FullSchedule] Ошибка сборки:', e.message);
      fullScheduleError = e.message;
      fullScheduleBuilding = false;
    });
    return fullSchedulePromise;
  }

  // Гарантировать, что полная копия готова (запустить сборку при необходимости)
  async function ensureFullSchedule() {
    if (fullScheduleCache) return fullScheduleCache;
    if (fullScheduleBuilding) return null;
    buildFullSchedule().catch(e => console.error('[FullSchedule] Фоновая сборка:', e.message));
    return null;
  }

  // Фильтрация уже готовой копии по аудитории и дате (мгновенно)
  async function getAudienceScheduleBseu(audience, date) {
    const targetAud = audience.trim();
    const schedule = await ensureFullSchedule();
    
    if (!schedule && !fullScheduleCache) {
      return { 
        data: [], 
        isFallback: false, 
        isBuilding: true,
        buildingStartedAt: fullScheduleStartedAt,
        message: 'Идёт загрузка полного расписания аудиторий. Пожалуйста, подождите.'
      };
    }
    
    const src = schedule || fullScheduleCache || [];

    const collected = src.filter(p =>
      (p.audience === targetAud || p.audienceTokens.includes(targetAud)) && p.dates.includes(date)
    ).map(p => ({
      shortNameRU: p.subject,
      lessonTypeShortNameRU: p.type,
      teachers: p.teacher ? [p.teacher] : [],
      groups: [p.groupText],
      audience: p.audience,
      startTime: p.startTime,
      endTime: p.endTime
    }));

    collected.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));

    let dayNameRU = '';
    try {
      dayNameRU = new Date(date + 'T00:00:00').toLocaleDateString('ru-RU', { weekday: 'long' });
    } catch (e) { /* ignore */ }

    const payload = [{
      scheduleOnDays: [{
        id: 0,
        date: date + 'T00:00:00',
        dayNameRU,
        week: 0,
        lessons: collected
      }]
    }];

    return { data: payload, isFallback: false, fromCache: false, builtAt: fullScheduleUpdatedAt };
  }

  // Serve static files
  app.use(express.static(__dirname));

  // Fallback: serve index.html or schedj.js
  app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running at http://0.0.0.0:${PORT}`);
    if (!fullScheduleCache) {
      console.warn('[Cache] Кэш не загружен. Пытаемся собрать через API...');
      buildFullSchedule().catch(e => console.error('[FullSchedule] Ошибка начальной сборки:', e.message));
    } else {
      console.log(`[Cache] Загружен кэш с ${fullScheduleCache.length} записями.`);
    }
    setInterval(() => {
      buildFullSchedule().catch(e => console.error('[FullSchedule] Ошибка периодической сборки:', e.message));
    }, FULL_SCHEDULE_INTERVAL);
  });

  server.on('error', (err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
  });
}

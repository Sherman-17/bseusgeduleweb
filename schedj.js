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

//id of tab, rest params - list of additional controls
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
  var http = require('http');
  var fs = require('fs');
  var path = require('path');
  var iconv = require('iconv-lite');
  var PORT = process.env.PORT || 3000;

  // Используем __dirname для надёжного разрешения пути к auth-модулю
  // независимо от текущего рабочего каталога на хостинге.
  // Пробуем несколько вариантов расположения папки server относительно schedj.js.
  var AUTH_MODULE_CANDIDATES = [
    path.join(__dirname, 'server', 'auth'),
    path.join(__dirname, '..', 'server', 'auth')
  ];

  // BSEU declares UTF-8 but actually returns windows-1251 bytes. We try to
  // decode as win1251; if the result contains genuine cyrillic letters we use
  // it, otherwise we fall back to UTF-8.
  function hasCyrillic(str) {
    return /[?-??-???]/.test(str);
  }
  function decodeBuffer(buffer) {
    try {
      var win = iconv.decode(buffer, 'win1251');
      if (hasCyrillic(win)) return win;
    } catch (e) {}
    return buffer.toString('utf-8');
  }

  // Proxy to studhub.by JSON API (audiences + audience schedule). studhub
  // returns JSON, ??????? ????????????? windows-1251 ?? ?????????.
  function handleStudhubProxy(targetUrl, res) {
    fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'api-version': '1.0',
        'Origin': 'https://studhub.by',
        'Referer': 'https://studhub.by/bseu/schedule/audiences',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    }).then(function (response) {
      return response.text().then(function (body) {
        var contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
        res.writeHead(response.status, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
        res.end(body);
      });
    }).catch(function (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'proxy_failed', message: err.message }));
    });
  }

  // --- ???????? ? ????????????? (?????+??????, ??? email) ---
  // ?????????????? ??????? ?????? ?? server/auth.js (SQLite + bcrypt).
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
  if (!auth) {
    console.error('[AUTH] Auth module could not be loaded from any candidate path');
    console.error('[AUTH] __dirname =', __dirname);
    console.error('[AUTH] process.cwd() =', process.cwd());
    console.error('[AUTH] Listing server/ directory:');
    try {
      var serverDir = path.join(__dirname, 'server');
      console.error('[AUTH] server dir contents:', fs.readdirSync(serverDir));
    } catch (e2) {
      console.error('[AUTH] Cannot list server dir:', e2.message);
    }
    // Последний fallback: ищем server/auth.js рекурсивно в родительских директориях
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

  var COOKIE_NAME = 'bseu_session';
  var AUTH_RATE_LIMIT = 5;
  var AUTH_RATE_WINDOW = 60 * 1000;
  var authAttempts = {}; // ip -> { count, resetAt }

  function parseCookies(req) {
    var raw = req.headers.cookie || '';
    var out = {};
    raw.split(';').forEach(function (pair) {
      var idx = pair.indexOf('=');
      if (idx === -1) return;
      var k = pair.slice(0, idx).trim();
      var v = pair.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    });
    return out;
  }
  function getToken(req) {
    var c = parseCookies(req);
    return c[COOKIE_NAME] || '';
  }
  function sendJson(res, status, obj, extraHeaders) {
    var headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (extraHeaders) Object.keys(extraHeaders).forEach(function (k) { headers[k] = extraHeaders[k]; });
    res.writeHead(status, headers);
    res.end(JSON.stringify(obj));
  }
  function setSessionCookie(res, token) {
    var str = COOKIE_NAME + '=' + encodeURIComponent(token) +
      '; Max-Age=' + Math.floor((1000 * 60 * 60 * 24 * 30) / 1000) +
      '; Path=/; HttpOnly; SameSite=Lax';
    res.setHeader('Set-Cookie', str);
  }
  function clearSessionCookie(res) {
    res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; Max-Age=0; HttpOnly');
  }
  function authRateLimited(ip) {
    var now = Date.now();
    var rec = authAttempts[ip];
    if (!rec || rec.resetAt < now) {
      authAttempts[ip] = { count: 1, resetAt: now + AUTH_RATE_WINDOW };
      return false;
    }
    rec.count += 1;
    return rec.count > AUTH_RATE_LIMIT;
  }
  function readJsonBody(req, cb) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () {
      var raw = Buffer.concat(chunks).toString('utf-8');
      // ?????????? ????? (#account-form) ???????????? ??????? ? iframe ???
      // application/x-www-form-urlencoded (login=...&password=...). ????????????
      // ??? ???????: urlencoded ? JSON.
      var ct = (req.headers['content-type'] || '').toLowerCase();
      if (ct.indexOf('application/x-www-form-urlencoded') !== -1) {
        try {
          var params = new URLSearchParams(raw);
          var obj = {};
          params.forEach(function (v, k) { obj[k] = v; });
          cb(null, obj);
        } catch (e) { cb(null, {}); }
        return;
      }
      try { cb(null, JSON.parse(raw || '{}')); }
      catch (e) { cb(null, {}); }
    });
  }
  // ????????????? ?????????? ????????/?????????????.
  function handleAuth(req, res, pathname) {
    if (!auth) { sendJson(res, 500, { error: 'auth_disabled' }); return; }
    var ip = req.socket.remoteAddress || 'unknown';
    var token = getToken(req);
    var session = auth.getSession(token);

    if (pathname === '/api/auth/register' && req.method === 'POST') {
      if (authRateLimited(ip)) { sendJson(res, 429, { error: '??????? ????? ???????. ?????????? ?????.' }); return; }
      readJsonBody(req, function (err, body) {
        console.error('[DEBUG register] body=', JSON.stringify(body), 'login=', body && body.login);
        try {
          var user = auth.registerUser(body.login, body.password);
          var t = auth.createSession(user.id, user.login);
          setSessionCookie(res, t);
          sendJson(res, 200, { ok: true, user: { login: user.login } });
        } catch (e) { sendJson(res, 400, { error: e.message }); }
      });
      return;
    }
    if (pathname === '/api/auth/login' && req.method === 'POST') {
      if (authRateLimited(ip)) { sendJson(res, 429, { error: '??????? ????? ???????. ?????????? ?????.' }); return; }
      readJsonBody(req, function (err, body) {
        var user = auth.verifyUser(body.login, body.password);
        if (!user) { sendJson(res, 401, { error: '???????? ????? ??? ??????' }); return; }
        var t = auth.createSession(user.id, user.login);
        setSessionCookie(res, t);
        sendJson(res, 200, { ok: true, user: { login: user.login } });
      });
      return;
    }
    if (pathname === '/api/auth/logout' && req.method === 'POST') {
      auth.destroySession(token);
      clearSessionCookie(res);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/api/auth/me' && req.method === 'GET') {
      if (!session) { sendJson(res, 200, { ok: true, user: null }); return; }
      sendJson(res, 200, { ok: true, user: { login: session.login } });
      return;
    }
    if (pathname === '/api/auth/account' && req.method === 'DELETE') {
      if (!session) { sendJson(res, 401, { error: '?? ???????????' }); return; }
      auth.deleteUser(session.userId);
      clearSessionCookie(res);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (pathname === '/api/sync' && req.method === 'GET') {
      if (!session) { sendJson(res, 401, { error: '?? ???????????' }); return; }
      sendJson(res, 200, { ok: true, blocks: auth.getBlocks(session.userId) });
      return;
    }
    if (pathname === '/api/sync' && req.method === 'POST') {
      if (!session) { sendJson(res, 401, { error: '?? ???????????' }); return; }
      readJsonBody(req, function (err, body) {
        var blocks = Array.isArray(body.blocks) ? body.blocks : [];
        var valid = blocks.filter(function (b) { return b && typeof b.kind === 'string' && typeof b.payload === 'string'; });
        var merged = auth.applyBlocks(session.userId, valid);
        sendJson(res, 200, { ok: true, blocks: merged });
      });
      return;
    }
    sendJson(res, 404, { error: 'not_found' });
  }

  // Proxy to BSEU schedule endpoint so the browser can fetch forms/courses/groups.
  function handleProxy(req, res) {
    var bodyChunks = [];
    req.on('data', function (c) { bodyChunks.push(c); });
    req.on('end', function () {
      var payload;
      try {
        payload = JSON.parse(Buffer.concat(bodyChunks).toString('utf-8') || '{}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'bad_json' }));
        return;
      }
      var targetUrl = payload.url || 'https://bseu.by/schedule/';
      var postBody = payload.body || '';
      // BSEU expects the request body encoded in windows-1251.
      var postBuffer = iconv.encode(postBody, 'win1251');
      fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=windows-1251',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        body: postBuffer
      }).then(function (response) {
        return response.arrayBuffer().then(function (buf) {
          var buffer = Buffer.from(buf);
          var decoded = decodeBuffer(buffer);
          res.writeHead(response.status, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(decoded);
        });
      }).catch(function (err) {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'proxy_failed', message: err.message }));
      });
    });
  }

  var server = http.createServer(function (req, res) {
    var parsed = new URL(req.url, 'http://localhost');
    var pathname = decodeURIComponent(parsed.pathname);

    if (pathname === '/api/proxy' && req.method === 'POST') {
      handleProxy(req, res);
      return;
    }

    // --- ?????????? ?? ?????????? (API studhub.by) ---
    // ?????? ?????????.
    if (pathname === '/api/audiences' && req.method === 'GET') {
      handleStudhubProxy('https://studhub.by/Schedule/3/audiences?', res);
      return;
    }
    // ?????????? ?????????? ????????? ?? ????.
    if (pathname === '/api/schedule' && req.method === 'GET') {
      var q = parsed.searchParams;
      var audience = (q.get('audience') || '').trim();
      var date = (q.get('date') || '').trim();
      if (!audience || !date) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'missing_params' }));
        return;
      }
      handleStudhubProxy(
        'https://studhub.by/Schedule/3/audiences/' + encodeURIComponent(audience) + '/schedule/date/' + encodeURIComponent(date),
        res
      );
      return;
    }

    // --- ???????? ? ????????????? (?????+??????, ??? email) ---
    if (pathname.indexOf('/api/auth/') === 0 || pathname === '/api/sync') {
      handleAuth(req, res, pathname);
      return;
    }


    var file = pathname === '/' ? 'index.html' : pathname;
    var filePath = path.join(__dirname, file.split('?')[0]);
    fs.readFile(filePath, function (err, data) {
      if (err) {
        fs.readFile(path.join(__dirname, 'schedj.js'), function (e2, js) {
          if (e2) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not found');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
            res.end(js);
          }
        });
        return;
      }
      var ext = path.extname(filePath).toLowerCase();
      var types = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.webmanifest': 'application/manifest+json'
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  server.listen(PORT, '0.0.0.0', function () {
    console.log('Server is running at http://0.0.0.0:' + PORT);
  });
  server.on('error', function (err) {
    console.error('Server failed to start:', err);
    process.exit(1);
  });
}

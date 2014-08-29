var fs      = require('fs');
var request = require('request');
var express = require('express');
var extend  = require('extend');

// ------------------------------------------
//  CONSTRUCTOR
// ------------------------------------------

var init = function(){
  info('Starting PluginManager ...');
  
  // Refresh local plugins
  refresh();

  // Refresh remote plugins
  remote();
  
  return PluginManager;
}

// ------------------------------------------
//  HELPER: REQUIRE 
// ------------------------------------------

/**
 * Removes a module from the cache
 */
require.uncache = function (moduleName) {
  // Run over the cache looking for the files
  // loaded by the specified module name
  require.searchCache(moduleName, function (mod) {
    delete require.cache[mod.id];
  });
};

/**
 * Runs over the cache to search for all the cached files
 */
require.searchCache = function (moduleName, callback) {
  // Resolve the module identified by the specified name
  var mod = require.resolve(moduleName);

  // Check if the module has been resolved and found within
  // the cache
  if (mod && ((mod = require.cache[mod]) !== undefined)) {
    // Recursively go over the results
    (function run(mod) {
      // Go over each of the module's children and
      // run over it
      mod.children.forEach(function (child) {
          run(child);
      });

      // Call the specified callback providing the
      // found module
      callback(mod);
    })(mod);
  }
};

// ------------------------------------------
//  CLASS: PLUGIN
// ------------------------------------------

var TYPE_MODULES  = 'modules';
var TYPE_PHANTOMS = 'phantoms';
var TYPE_CRON     = 'cron';

function Plugin(options) {
  extend(false, this, options);
  
  // Link configuration
  this.config   = Config[TYPE_MODULES][this.name];
  this.phantoms = Config[TYPE_PHANTOMS][this.name];
  this.cron     = Config[TYPE_CRON][this.name];
  
  // Check has {plugin}.js
  var script = SARAH.ConfigManager.PLUGIN+'/'+this.name+'/'+this.name+'.js';
  if (fs.existsSync(script)){ 
    this.script = script;
  }
  
  // Check has custom portlet.html
  var template = SARAH.ConfigManager.PLUGIN+'/'+this.name+'/portlet.html';
  if (fs.existsSync(template)){
    this.template = template;
  } else {
    this.template = 'portlet.html';
  }
  
  // Check has index.html
  var index = SARAH.ConfigManager.PLUGIN+'/'+this.name+'/index.html';
  if (fs.existsSync(index)){
    this.index = index;
  }
}

Plugin.prototype.isDisabled = function(){
  if (!this.script) return true;
  return this.config.disabled;
}


Plugin.prototype.getLocale = function(locale){
  var path = SARAH.ConfigManager.PLUGIN+'/'+this.name+'/locales/'+locale+'.js';
  if (!fs.existsSync(path)){ return; }
  try { 
    var json = fs.readFileSync(path);
    info('Loading locales %s', path); 
    if (json) return JSON.parse(json); 
  } 
  catch(ex){ warn("Can't parse %s locales in %s", this.name, locale); }
  
  return false;
}

Plugin.prototype.getInstance = function(uncache){
  try {
    // Dispose
    if (Config.debug || uncache){ 
      if (this._script && this._script.dispose){ this._script.dispose(); }
      require.uncache(this.script); 
    }
    
    // Require
    this._script = require(this.script);
    
    // Initialise
    if (!this._script.initialized){
      this._script.initialized = true;
      if (this._script.init){ this._script.init(); }
    }
    
    // Last Modified
    var modified = fs.statSync(this.script).mtime.getTime();
    if (!this._script.lastModified){
      this._script.lastModified = modified;
    }
    
    // Reload if new version
    if (this._script.lastModified < modified){
      info('Reloading: ', this.name);
      return this.getInstance(true);
    }
    
    return this._script;
  } 
  catch (ex) { 
    warn('Error while loading plugin: ', ex.message);
  }
}

// ------------------------------------------
//  CACHE PLUGINS
// ------------------------------------------

var cache    = {};
var getCache = function(){ return cache;  }

var refresh = function(){
  
  cache = {};
  
  // Find config
  var keys = Object.keys(Config[TYPE_MODULES]);
  
  // Build a list of plugins
  for(var i = 0 ; i < keys.length ; i++){
    var key = keys[i];
    cache[key] = new Plugin ({'name' : key });
  }
  
  keys = Object.keys(Config[TYPE_PHANTOMS]);
  for(var i = 0 ; i < keys.length ; i++){
    var key = keys[i];
    if (cache[key]) continue;
    cache[key] = new Plugin ({'name' : key });
  }
  
  keys = Object.keys(Config[TYPE_CRON]);
  for(var i = 0 ; i < keys.length ; i++){
    var key = keys[i];
    if (cache[key]) continue;
    cache[key] = new Plugin ({'name' : key });
  }
}

// ------------------------------------------
//  PLUGIN LOCALES
// ------------------------------------------

var getLocales = function(locale){ 
  var prop   = {}
  var keys   = Object.keys(cache);
  for(var i  = 0 ; i < keys.length ; i++){
    var key  = keys[i];
    var json = cache[key].getLocale(locale);
    if (json){ extend(true, prop, json); }
  }
  return prop;  
}

// ------------------------------------------
//  PLUGIN LIST
// ------------------------------------------

var sort = function(ids, xPos, yPos){
  for(var i = 0 ; i < ids.length ; i++){
    var cfg = cache[ids[i]].config;
    cfg.x = parseInt(xPos[i])+1;
    cfg.y = parseInt(yPos[i])+1;
  }
  getList(true);
}

var getList = function(refresh){ 
  
  var keys = Object.keys(cache);
  keys = keys.sort(function(k1, k2){
    var conf1 = cache[k1].config;
    var conf2 = cache[k2].config;
    
    if (!conf1.y) return  1;
    if (!conf2.y) return -1;
    
    if (conf1.y < conf2.y) return  -1;
    if (conf1.y > conf2.y) return   1;
    return conf1.x < conf2.x ? -1 : 1;
  });
  
  var list = [];
  for(var i = 0 ; i < keys.length ; i++){
    var key = keys[i];
    var plugin = cache[key];
    
    // Skip disabled plugin
    if (plugin.isDisabled()){ continue; }
    
    list.push(plugin);
  }
  return list;
}

// ------------------------------------------
//  MARKETPLACE
// ------------------------------------------

var MARKETPLACE = 'http://plugins.sarah.encausse.net';

var cacheNet = {};
var remote = function(){
  request({ 
    'uri' : MARKETPLACE, 
    'json' : true,
    'headers': {'user-agent': SARAH.USERAGENT} 
  }, 
  function (err, response, json){
    if (err || response.statusCode != 200) {
      return warn("Can't retrieve remote plugins");
    }
    cacheNet = json;
  });
}

// ------------------------------------------
//  FIND / SEEK
// ------------------------------------------

var find = function(name){
  return cache[name];
}

var exists = function(name){
  var plugin = find(name);
  return plugin ? true : false;
}

// ------------------------------------------
//  EVENT
// ------------------------------------------

var events = require('events');
var ee = new events.EventEmitter();

var listen = function(event, callback){
  ee.on(event, callback);
}

var trigger = function(event, data){
  ee.emit(event, data);
}

// ------------------------------------------
//  ROUTER
// ------------------------------------------

var Router = express.Router();

Router.get('/plugin/help/:name', function(req, res, next) { 
  var name   = req.params.name; 
  var plugin = find(name);
  
  if (plugin.index) {
    return res.render(plugin.index, {'title' : i18n('modal.plugin.help', name)});
  }
  next();
});

Router.get('/plugin/config/:name', function(req, res, next) { 
  var name   = req.params.name; 
  var plugin = find(name);
  return res.render('plugin/config.ejs', {'title' : i18n('modal.plugin.config', name) });
});

Router.post('/plugin/config/:name', function(req, res, next) { 
  var name    = req.params.name; 
  var plugin  = find(name);
  var keys    = Object.keys(req.body);
  for(var i   = 0 ; i < keys.length ; i++){
    var key   = keys[i];
    var value = parse(req.body[key]);
    var pfx   = key.substring(0, key.indexOf('.'));
    var prop  = key.substring(key.indexOf('.')+1);
    Config[pfx][name][prop] = value;
  }
  SARAH.ConfigManager.save();
  return res.render('plugin/config.ejs', {'title' : i18n('modal.plugin.config', name), 'message' : true });
});

Router.get('/plugin/edit/:name', function(req, res, next) { 
  var name   = req.params.name; 
  var plugin = find(name);
  return res.render('plugin/edit.ejs', {'title' : i18n('modal.plugin.edit', name)});
});

Router.all('/plugin/sort', function(req, res, next) { 
  sort(req.query.ids, req.query.xPos, req.query.yPos);
  SARAH.ConfigManager.save();
  res.end();
});

Router.all('/plugin/:name*', function(req, res, next) { 
  var plugin = find(req.params.name);
  if (!plugin) return res.end();
  res.render('portal/portlet.ejs', { "plugin" : plugin});
});


var parse = function(str){
  if (str === 'true')  return true;
  if (str === 'false') return false;
  var num = parseInt(str);
  return isNaN(num) ? str : num;
}

// ------------------------------------------
//  PUBLIC
// ------------------------------------------

var PluginManager = {
  'init' : init,
  'getCache'      : getCache,
  'getList'       : getList,
  'getLocales'    : getLocales,
  
  'find'          : find,
  'exists'        : exists,
  
  'trigger'       : trigger,
  'listen'        : listen,
  
  'Router'        : Router
}

// Exports Manager
exports.init = PluginManager.init;
/*
 * Tailspin - Reversible JS implemented in JS.
 * Will Thimbleby <will@thimbleby.net>
 *
 * Interpreter and sandboxed versions of built-in functions.
 * Function creation and calling.
 */

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */


var Sandbox = function (interpreter) {
var functionInternals = new Definitions.WeakMap();

// We create an iframe to sandbox the base objects.
var nativeBase;
var sandbox;

var sandboxFns = 'nativeBase = (new Function("return this"))();\n\
\n\
// Creates a function in the sandbox from the string fnStr.\n\
// fnStr will reference continuationMarker, fint and x.\n\
newFnFunction = function(continuationMarker, fint, x, fnStr) {\n\
    var newFn;\n\
    if (fint.node.body.strict) {\n\
        (function() {\n\
            "use strict"\n\
            newFn = eval(fnStr);\n\
        })();\n\
    }\n\
    else {\n\
        newFn = eval(fnStr);\n\
    }\n\
    return newFn;\n\
};\n\
\n\
// Turns the array a into an arguments object.\n\
makeArguments = function(a) {\n\
    return (function(){return arguments}).apply(undefined, a);\n\
};\n\
\n\
// Apply functions used in order to run functions in the sandbox.\n\
applyNew = function(f, a) {\n\
    return new (f.bind.apply(f, [,].concat(Array.prototype.slice.call(a))))();\n\
};\n\
\n\
apply = function(f, t, a) {\n\
    return f.apply(t, a);\n\
};';

// When we are in a position to create an iframe, use an iframe to sandbox the interpreter.
// e.g. not running in a browser, or in a web worker
if (typeof document === "object") {
    var iframe = document.createElement("iframe");
    iframe.style.display = "none";
    document.body.appendChild(iframe);
    
    iframe.contentWindow.document.write('<script type="text/javascript">'+sandboxFns+'</script>');
    
    nativeBase = (new Function("return this"))();
    sandbox = iframe.contentWindow;
    applyNew = Definitions.applyNew;
}
else {
    // Having the sandbox the same as the Tailspin's host is less ideal
    // because there is more chance of polluting the host interpreter.
    // But if we are unable to create an iframe to contain sandboxed versions of
    // Object, Array etc. this will have to do.
    eval(sandboxFns);
    
    nativeBase = (new Function("return this"))();
    sandbox = nativeBase;
}

// The underlying global object for narcissus.
var globalBase = {
    // Value properties.
    NaN: sandbox.NaN,
    Infinity: sandbox.Infinity,
    undefined: sandbox.undefined,

    eval: sandbox.eval,
    Function: sandbox.Function,
    
    Array: sandbox.Array,
    Boolean: sandbox.Boolean,
    Date: sandbox.Date,
    Number: sandbox.Number,
    Object: sandbox.Object,
    RegExp: sandbox.RegExp,
    String: sandbox.String,
    
    Error: sandbox.Error,
    EvalError: sandbox.EvalError,
    RangeError: sandbox.RangeError,
    ReferenceError: sandbox.ReferenceError,
    SyntaxError: sandbox.SyntaxError,
    TypeError: sandbox.TypeError,
    URIError: sandbox.URIError,
    
    escape: sandbox.escape,
    unescape: sandbox.unescape,
    
    parseInt: sandbox.parseInt,
    parseFloat: sandbox.parseFloat,
    
    isNaN: sandbox.isNaN,
    isFinite: sandbox.isFinite,
    
    encodeURI: sandbox.encodeURI,
    decodeURI: sandbox.decodeURI,
    encodeURIComponent: sandbox.encodeURIComponent,
    decodeURIComponent: sandbox.decodeURIComponent,
    
    Math: sandbox.Math,
    JSON: sandbox.JSON,
};


// Create internal functions for eval and Function.
functionInternals.set(sandbox.eval, {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev, options) {
        // if argument is not a string just return it
        if (typeof a[0] !== "string") {
            return a[0];
        }
        
        var indirectEval = options && options.indirectEval;
        var calledFromStrictCode = indirectEval? false : x.strict;
        var ast = Parser.parse(a[0], null, null, calledFromStrictCode);
        
        // create a new execution context for the eval
        var x2 = interpreter.createEvalExecutionContext(calledFromStrictCode);
        
        // Section 10.4.3 Entering Function Code.
        var isStrict = ast.strict;
        if (indirectEval) {
            x2.thisObject = global;
        }
        else if (isStrict) {
            x2.thisObject = t;
        }
        else if (t === null || t === undefined) {
            x2.thisObject = global;
        }
        else {
            x2.thisObject = toObject(t);
        }
        
        x2.functionInstance = this;
        x2.control = x.control;
        x2.asynchronous = x.asynchronous;
        
        if (!indirectEval) {
            x2.scope = x.scope;
        }
        else {
            x2.scope = {object: global, parent: null};
        }
        
        if (isStrict) {
            // strict mode for eval runs in a new scope
            x2.scope = {object: new Object(), parent: x2.scope};
        }
        
        if (ast.hasModules) {
            thrw("Modules not supported.");
        }
        
        x2.execute(ast, function(v, prev) {next(x2.result, prev);}, null, null, null, thrw, prev);
    },
    construct: function() {}
});

functionInternals.set(sandbox.Function, {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev) {
        this.construct(f, a, x, next, ret, cont, brk, thrw, prev);
    },
    construct: function(f, a, x, next, ret, cont, brk, thrw, prev) {
        var p = "", b = "", n = a.length;
        if (n) {
            var m = n - 1;
            if (m) {
                p += a[0];
                for (var k = 1; k < m; k++) {
                    p += "," + a[k];
                }
            }
            b += a[m];
        }
 
        // XXX We want to pass a good file and line to the tokenizer.
        // Note the anonymous name to maintain parity with Spidermonkey.

        // NB: Use the STATEMENT_FORM constant since we don't want to push this
        // function onto the fake compilation context.
        var f = Parser.parseFunction("anonymous(" + p + ") {" + b + "}", false, Parser.STATEMENT_FORM);
        
        var x2 = {};
        x2.scope = {object: global, parent: null};
        x2.stack = [];
        next(newFunction(f, x2), prev);
    }
});

// Sandboxed functions provide alternative toString functions.
var oldToStr = sandbox.Function.prototype.toString;
Object.defineProperty(sandbox.Function.prototype, "toString", {value:function() {
    var fint = functionInternals.get(this);
    return fint? fint.toString() : oldToStr.call(this);
}, enumerable:false, writable:true});

functionInternals.set(sandbox.Function.prototype.call, {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev) {
        var fint = functionInternals.get(t);
        if (fint) {
            if (typeof t !== "function") {
                thrw(new sandbox.TypeError("Call must be called on a function."));
            }
            else {
                var thisArg = (fint.node && fint.node.body.strict)? a[0] : toObject(a[0]);
                var args = Array.prototype.splice.call(a, 1);
                fint.call(t, thisArg, args, x, next, ret, cont, brk, thrw, prev, {callViaFunctionApply:true});
            }
        }
        else {
            next(sandbox.apply(sandbox.Function.prototype.call, t, a), prev);
        }
    },
    construct: function(f, a, x, next, ret, cont, brk, thrw, prev) {
    }
});

functionInternals.set(sandbox.Function.prototype.apply, {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev) {
        var fint = functionInternals.get(t);
        if (fint) {
            if (typeof t !== "function") {
                thrw(new sandbox.TypeError("Apply must be called on a function."));
            }
            else {
                var thisArg = (fint.node && fint.node.body.strict)? a[0] : toObject(a[0]);
                var args = a[1];
                if (args === null || args === undefined) {
                    args = [];
                }
                else if (!isObject(args)) {
                    thrw(new sandbox.TypeError("Apply arguments must be an object."));
                    return;
                }
                fint.call(t, thisArg, args, x, next, ret, cont, brk, thrw, prev, {callViaFunctionApply:true});
            }
        }
        else {
            next(sandbox.apply(sandbox.Function.prototype.apply, t, a), prev);
        }
    },
    construct: function(f, a, x, next, ret, cont, brk, thrw, prev) {
    }
});

// Array functions.
// Adding reversible versions of mutating methods.
// Use sandbox.apply(fn, this, args...) instead of fn.apply(this, args...) so that
// function call happens in sandbox frame and returns array from the sandbox for Safari.
var popFn = sandbox.Array.prototype.pop;
var pushFn = sandbox.Array.prototype.push;
var shiftFn = sandbox.Array.prototype.shift;
var unshiftFn = sandbox.Array.prototype.unshift;
var spliceFn = sandbox.Array.prototype.splice;
var reverseFn = sandbox.Array.prototype.reverse;
var sortFn = sandbox.Array.prototype.sort;
functionInternals.set(pushFn, {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev) {
        var originalLength = t.length;
        var newPrev = function() {
            sandbox.apply(spliceFn, t, [originalLength, a.length])
            prev();
        }
        next(sandbox.apply(pushFn, t, a), newPrev);
    },
    construct: function(f, a, x, next, ret, cont, brk, thrw, prev) {
    }
});

functionInternals.set(popFn, {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev) {
        if (t.length > 0) {
            var popped = sandbox.apply(popFn, t, a);
            var newPrev = function() {
                sandbox.apply(pushFn, t, [popped])
                prev();
            }
            next(popped, newPrev);
        }
        else {
            next(undefined, prev);
        }
    },
    construct: function(f, a, x, next, ret, cont, brk, thrw, prev) {
    }
});

functionInternals.set(shiftFn, {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev) {
        if (t.length > 0) {
            var shifted = sandbox.apply(shiftFn, t, a);
            var newPrev = function() {
                sandbox.apply(unshiftFn, t, [shifted])
                prev();
            }
            next(shifted, newPrev);
        }
        else {
            next(undefined, prev);
        }
    },
    construct: function(f, a, x, next, ret, cont, brk, thrw, prev) {
    }
});

functionInternals.set(unshiftFn, {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev) {
        var newPrev = function() {
            sandbox.apply(spliceFn, t, [0, a.length]);
            prev();
        }
        next(sandbox.apply(unshiftFn, t, a), newPrev);
    },
    construct: function(f, a, x, next, ret, cont, brk, thrw, prev) {
    }
});

functionInternals.set(spliceFn, {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev) {
        var oldItems = sandbox.Array.prototype.slice.apply(t);
        var newPrev = function() {
            var c = oldItems.length;
            t.length = c;
            for (var i=0; i<c; i++) {
                t[i] = oldItems[i];
            }
            prev();
        }
        next(sandbox.apply(spliceFn, t, a), newPrev);
    },
    construct: function(f, a, x, next, ret, cont, brk, thrw, prev) {
    }
});

functionInternals.set(reverseFn, {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev) {
        var newPrev = function() {
            sandbox.apply(reverseFn, t);
            prev();
        }
        next(sandbox.apply(reverseFn, t), newPrev);
    },
    construct: function(f, a, x, next, ret, cont, brk, thrw, prev) {
    }
});

functionInternals.set(sortFn, {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev) {
        var oldItems = sandbox.Array.prototype.slice.apply(t);
        var newPrev = function() {
            var c = oldItems.length;
            t.length = c;
            for (var i=0; i<c; i++) {
                t[i] = oldItems[i];
            }
            prev();
        }
        next(sandbox.apply(sortFn, t, a), newPrev);
    },
    construct: function(f, a, x, next, ret, cont, brk, thrw, prev) {
    }
});

var maxRnd = 4294967296;
var rndSeed = Math.random()*maxRnd;

functionInternals.set(sandbox.Math.random, {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev) {
        var oldSeed = rndSeed;
        // Use a LCG.
        rndSeed = (1664525*rndSeed+1013904223)%maxRnd;
        var rndFloat = rndSeed/maxRnd;
        
        var newPrev = function() {
            rndSeed = oldSeed;
            prev();
        }
        
        next(rndFloat, newPrev);
    },
    construct: function(f, a, x, next, ret, cont, brk, thrw, prev) {
    }
});

// Needs reversible support for Object.defineProperty and Object.defineProperties.
// Note: support for reversible seal and freeze requires lots of work.

// Conversion functions to move native objects into the sandbox.
var nativeToSandboxErrors = [
    Error, sandbox.Error,
    EvalError, sandbox.EvalError,
    RangeError, sandbox.RangeError,
    ReferenceError, sandbox.ReferenceError,
    SyntaxError, sandbox.SyntaxError,
    TypeError, sandbox.TypeError,
    URIError, sandbox.URIError
];
var nativeToSandboxClasses = [
    Number, sandbox.Number,
    String, sandbox.String
];

function sandboxError(e, fileName, lineNumber) {
    var i = nativeToSandboxErrors.indexOf(e.constructor);
    if (i>=0 && i%2===0) {
        var newError = new nativeToSandboxErrors[i+1](e.message);
        if (typeof fileName === "string" && typeof lineNumber === "number") {
            newError.sourceFile = fileName;
            newError.sourceLine = lineNumber;
        }
        return newError;
    }
    return e;
}
function sandboxBaseValue(v) {
    var i = nativeToSandboxClasses.indexOf(v.constructor);
    if (i>=0 && i%2===0) {
        return nativeToSandboxClasses[i+1](v);
    }
    return v;
}
function sandboxArray(v) {
    return sandbox.apply(sandbox.Array.prototype.slice, v);
}
function newTypeError(msg, filename, lineNumber) {
    var error = new sandbox.TypeError(msg);
    error.sourceLine = lineNumber;
    error.sourceFile = filename;
    return error;
}
function newReferenceError(msg, filename, lineNumber) {
    var error = new sandbox.ReferenceError(msg);
    error.sourceLine = lineNumber;
    error.sourceFile = filename;
    return error;
}


// set globalBase's property descriptors to be the same as the native descriptors
var names = Object.getOwnPropertyNames(globalBase);
for (var i = 0, n = names.length; i < n; i++) {
    var key = names[i];
    var propDesc = Object.getOwnPropertyDescriptor(nativeBase, names[i]);
    Object.defineProperty(globalBase, key, {configurable:propDesc.configurable,
        enumerable:propDesc.enumerable, writable:propDesc.writable});
}


var global = new sandbox.Object();

function resetEnvironment() {
    var names = Object.getOwnPropertyNames(global);
    for (var i = 0, n = names.length; i < n; i++) {
        delete global[names[i]];
    }

    var names = Object.getOwnPropertyNames(globalBase);
    for (i = 0, n = names.length; i < n; i++) {
        var key = names[i];
        var val = globalBase[key];
        global[key] = val;
        
        // set property descriptor to be the same as globalBase's
        Object.defineProperty(global, key, Object.getOwnPropertyDescriptor(globalBase, key));
    }
}
resetEnvironment();



// Borrowed from Prototype.
function argumentNames(fn) {
    var names = fn.toString().match(/^[\s\(]*function[^(]*\(([^)]*)\)/)[1]
      .replace(/\/\/.*?[\r\n]|\/\*(?:.|[\r\n])*?\*\//g, '')
      .replace(/\s+/g, '').split(',');
    return names.length == 1 && !names[0] ? [] : names;
}
  
// Translates a function into a pattern that the interpreter will call using continuations
// Only functions of the form fn($ret, $prev, ...) will be translated.
function translate(value, depth) {
    depth = typeof depth === "number"? depth : 0;
    
    if (typeof value === "function") {
        var fn = value;
        var argNames = argumentNames(fn);
        if (argNames[0] === "$ret" && argNames[1] === "$prev") {
            functionInternals.set(fn, {
                call: function(f, t, a, x, next, ret, cont, brk, thrw, prev) {
                    // Concat array-like args.
                    var args = [next, prev];
                    for (var i=0, c=a.length; i<c; i++) {
                        args[i+2] = a[i];
                    }
                    f.apply(t, args);
                },
                construct: function(f, a, x, next, ret, cont, brk, thrw, prev) {
                }
            });
        }
    }
    else if (typeof value === "object" && depth < 1) {
        // Translate objects to a depth of 1.
        var obj = {};
        for (var k in value) {
            if (value.hasOwnProperty(k)) {
                obj[k] = translate(value[k], depth+1);
            }
        }
        value = obj;
    }
    return value;
}


// Basic object checks
function isPrimitive(v) {
    var t = typeof v;
    return (t === "object") ? v === null : t !== "function";
}

function isObject(v) {
    var t = typeof v;
    return (t === "object") ? v !== null : t === "function";
}

// If r instanceof Reference, v === getValue(r); else v === r.  If passed, rn
// is the node whose execute result was r.
// Same as toObject, but throws a type error if v is null or undefined
function toObjectCheck(v, r, rn, next, thrw) {
    if (v === undefined || v === null) {
        // fixme: use thrw instead of throw
        var message = "'" + JSON.stringify(v) + "' is not an object (evaluating " +r+")";
        throw (rn ? newTypeError(message, rn.filename, rn.lineno)
            : newTypeError(message));
    }
    return toObject(v);
}

function toObject(v) {
    switch (typeof v) {
      case "boolean":
        return new global.Boolean(v);
      case "number":
        return new global.Number(v);
      case "string":
        return new global.String(v);
      default: // object, function, null, undefined
        return v;
    }
}


// Function creation and calling.
function FunctionInternals(node, scope) {
    this.node = node;
    this.scope = scope;
    this.length = node.params.length;
}


// Returns a new function.
function newFunction(n, x) {
    var fint = new FunctionInternals(n, x.scope);
    
    // ugly method of creating a function with the correct # of arguments
    var args = fint.length>0? "a0" : "";
    for (var i=1; i<fint.length; i++) {
        args += ",a"+i;
    }
        
    // do nothing if we detect special calling pattern: args===[continuationMarker]
    // when called like this the caller is responsible for calling fint.call()
    // if 'this' is the native global object (ie. DOMWindow) then we want to use our own global object
    var fnStr = "(function("+args+"){\n\
        if (arguments[arguments.length-1] !== continuationMarker) {\n\
            var t = (this === nativeBase? undefined : this);\n\
            return fint.call(newFn, t, arguments, x);\n\
        }})";
    
    // Pass the important values through to the sandbox.
    // Creating the new function in the sandbox.
    var newFn = sandbox.newFnFunction(continuationMarker, fint, x, fnStr);
    functionInternals.set(newFn, fint);
    
    return newFn;
}

function hasInstance(u, v) {
    if (isPrimitive(v))
        return false;
    var p = u.prototype;
    if (isPrimitive(p)) {
        throw new sandbox.TypeError("'prototype' property is not an object.",
                            this.node.filename, this.node.lineno);
    }
    var o;
    while ((o = Object.getPrototypeOf(v))) {
        if (o === p)
            return true;
        v = o;
    }
    return false;
}

// Construct a new function f with args.
function constructFunction(fn, args, x, next, ret, cont, brk, thrw, prev) {
    var fint = functionInternals.get(fn);
    if (!fint) {
        // Calling out to native function.
        // Catch native exception and convert into interpreter exception.
        try {
            var newFn = applyNew(fn, args);
            next(newFn, prev);
        }
        catch (e) {
            thrw(sandboxError(e), prev);
        }
    }
    else {
        fint.construct(fn, args, x, next, ret, cont, brk, thrw, prev);
    }
}

function callFunction(f, t, a, x, next, ret, cont, brk, thrw, prev, options) {
    var fint = functionInternals.get(f);
    if (!fint) {
        // calling out to native function
        // catch native exception and convert into interpreter exception
        try {
            // array-ify args object for iOS 5.1
            var args = [];
            for (var i=0, c=a.length; i<c; i++) {
                args[i] = a[i];
            }
            // sandbox.apply is a workaround for Safari generating return values in
            // non-sandbox environment. This is the same as:
            // var r = f.apply(t, args);
            var r = sandbox.apply(f, t, args);
            next(r, prev);
        }
        catch (e) {
            thrw(sandboxError(e), prev);
        }
    }
    else {
        fint.call(f, t, a, x, next, ret, cont, brk, thrw, prev, options);
    }
}

var continuationMarker = {};

function Activation(f, a) {
    for (var i = 0, j = f.params.length; i < j; i++) {
        Definitions.defineProperty(this, f.params[i], a[i], true);
    }
    Definitions.defineProperty(this, "arguments", a, true);
}

// Null Activation.prototype's proto slot so that Object.prototype.* does not
// pollute the scope of heavyweight functions.  Also delete its 'constructor'
// property so that it doesn't pollute function scopes.

Activation.prototype = Object.create(null);

var FIp = FunctionInternals.prototype = {
    call: function(f, t, a, x, next, ret, cont, brk, thrw, prev, options) {
        var x2 = interpreter.createFunctionExecutionContext(this.node.body.strict);
        
        // Get the 'this' object for the function call.
        if (x2.strict && options && options.callViaFunctionApply) {
            x2.thisObject = t;
        }
        else if (x2.strict) {
            x2.thisObject = (t !== global? t : undefined);
        }
        else {
            x2.thisObject = (t || global);
        }
        
        x2.functionInstance = this;
        x2.control = x.control;
        x2.asynchronous = x.asynchronous;
        // copy the stack and add the current node onto it
        x2.stack = x.stack.slice();
        x2.stack.push({node:x.currentNode, executionContext:x});
        
        // Convert the array a into a genuine arguments object from the sandbox.
        a = sandbox.makeArguments(a);
        Definitions.defineProperty(a, "callee", f, false, false, true);
        
        var n = this.node;
        x2.scope = {object: new Activation(n, a), parent: this.scope};
        if (next) {
            // next continuation enforces undefined value
            // ret continuation is next
            x2.execute(n.body, function(result, prev) {next(undefined, prev);},
                next, cont, brk, thrw, prev);
        }
        else {
            // called from non-interpreted code
            // convert interpreter exceptions into native JS exceptions
            // and function as a normal function that returns the result
            var returned = false;
            var hasException = false;
            var exception;
            
            // run without interuption
            x2.asynchronous = false;
            delete x2.control;
            
            x2.execute(n.body, function() {}, function() {returned=true;}, cont, brk,
                function(e) {hasException=true; exception=e;});
            
            if (hasException) {
                throw exception;
            }
            else if (returned) {
                return x2.result;
            }
            else {
                return undefined;
            }
        }
    },
    
    construct: function(fn, a, x, next, ret, cont, brk, thrw, prev) {
        var newObject = sandbox.applyNew(fn, [continuationMarker]);
        
        this.call(fn, newObject, a, x, function(r, prev) {
            if (typeof r === "object") {
                // If the function returned an object use that.
                next(r, prev);
            } else {
                // Otherwise use the object created by new.
                next(newObject, prev);
            }
          }, ret, cont, brk, thrw, prev);
    },
    
    toString: function() {
        var parenthesized = this.node.parenthesized;
        this.node.parenthesized = false;
        var result = Decompiler.pp(this.node);
        this.node.parenthesized = parenthesized;
        return result;
    }
};


function ExecutionContext(type, strict) {
    this.type = type;
    this.strict = !!strict;
    this.stack = [];
}

ExecutionContext.prototype = {
    scope: {object: global, parent: null},
    thisObject: global,
    functionInstance: null,
    result: undefined,
    target: null,
    control: null,
    asynchronous: false,

    // Execute a node in this execution context.
    execute: function(n, next, ret, cont, brk, thrw, prev) {
        interpreter.execute(n, this, next, ret, cont, brk, thrw, prev);
    },

    newFunction: function(n) {
        return newFunction(n, this);
    },
    
    copy: function() {
        var cpy = new ExecutionContext(this.type, this.strict);
        cpy.scope = this.scope;
        cpy.thisObject = this.thisObject;
        cpy.functionInstance = this.functionInstance;
        cpy.result = this.result;
        cpy.target = this.target;
        cpy.control = this.control;
        cpy.asynchronous = this.asynchronous;
        cpy.stack = this.stack.slice();
        return cpy;
    },
    
    lookupInScope: function(a) {
        for (var s = this.scope; s; s = s.parent) {
            if (a in s.object) {
                return s.object[a];
            }
        }
        return undefined;
    }
};


var exports = {};
exports.global = global;
exports.globalBase = globalBase;
exports.functionInternals = functionInternals;
exports.translate = translate;
exports.resetEnvironment = resetEnvironment;

exports.sandbox = sandbox;
exports.sandboxError = sandboxError;
exports.sandboxBaseValue = sandboxBaseValue;
exports.sandboxArray = sandboxArray;
exports.newTypeError = newTypeError;
exports.newReferenceError = newReferenceError;
exports.isPrimitive = isPrimitive;
exports.isObject = isObject;
exports.toObjectCheck = toObjectCheck;
exports.toObject = toObject;

exports.Activation = Activation;
exports.newFunction = newFunction;
exports.hasInstance = hasInstance;
exports.constructFunction = constructFunction;
exports.callFunction = callFunction;

exports.ExecutionContext = ExecutionContext;

return exports;
};
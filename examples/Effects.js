/** 
 * Algebraic Effects and Handlers as in <a href='http://www.eff-lang.org/'>Eff</a>
 */

'use strict'
//
// Note:
// new Continuation() - returns the current function's continuation.
//

function callcc(f) {
    return f(new Continuation())
}

/**
 * Implementation of delimited continuation operators given by Filinski
 */

function MetaContinuation() {

    var metaCont;
    var self = this

    function abort(thunk) {
        var v = thunk();
        var k = metaCont;
        return k(v);
    }

    /**
     * The reset operator sets the limit for the continuation 
     * @param {function} thunk
     */

    this.reset = function(thunk) {
        var saved = metaCont;
        var k = new Continuation();
        metaCont = function(v){
            metaCont = saved;
            var r = k(v);
            return r;
        };
        var r = abort(thunk);
        return r;
    }

    /**
     * The shift operator captures the continuation up to the innermost
     * enclosing reset
     */

    this.shift = function(f) {
        var k = new Continuation();
        var r = abort(function(){
            var r = f(function(v){
                var r = self.reset(function(){
                    var r = k(v);
                    return r;
                });
                return r;
            });
            return r;
        });
        return r;
    }
}

/** Factory to create effects */
function Effects() {

    var metaCont = new MetaContinuation();

    var OPS = {}; // Operation records
    var self = this;

    /**
     * Creates a new Effect
     * @param {string} effect - Name of this effect
     * @returns {Effect}
     */
    this.createEffect = function(effect) {
        return new Effect(effect);
    }

    /** 
     * Factory to create operations and handlers:
     */
    function Effect(effect) {

        /**
         * Creates a new operation.
         * @param {string} name - Name of this operation
         * @returns {function}
         */
        this.createOperation = function(name) {
            var key = effect +"#"+name;
            var op = OPS[key];
            if (undefined == op) {
                op = new Op(name);
                OPS[key] = op;
            }
            var result = function() {
                var args = [];
                for (var i = 0; i < arguments.length; i++) {
                    args.push(arguments[i]);
                }
                // find the handler for this operation and apply it to the arguments of this call together with its continuation
                var h = op.handler();
                var result = metaCont.shift(function(k) {
                    var result = h.call(null, {args: args, k: k});
                    return result;
                });
                return result;
            }
            return result;
        }
        
        /**
         * Creates a new handler
         * @param {object} handlers - an object with function properties which may be 'return', 'finally' or 
         * the names of operations
         * @returns {function}
         */

        this.createHandler = function(handlers) {
            var returnHandler = handlers["return"];
            var finallyHandler = handlers["finally"];
            var ops = [];
            var hs = [];
            for (var opName in handlers) {
                switch (opName) {
                case "return": 
                case "finally": 
                    break;
                default:
                    var h = handlers[opName];
                    var key = effect+"#"+opName;
                    var op = OPS[key];
                    if (undefined == op) {
                        op = new Op(opName);
                        OPS[key] = op;
                    }
                    ops.push(op);
                    hs.push(h);
                }
            }
            return new Handler(returnHandler, finallyHandler, ops, hs);
        }

        // Operation record
        function Op(name) {
            this.name = name;
            this.handler = function() { return function() {throw "no handler: "+effect +"#"+name} }
            this.toString = function() {
                return effect +"#"+name
            }
        }

        // Handler record
        function Handler(returnHandler, finallyHandler, ops, hs) {
            function _return(result) {
                if (undefined != returnHandler) {
                    result = returnHandler(result);
                }
                return result;
            }
            function _finally(result) {
                if (undefined != finallyHandler) {
                    result = finallyHandler(result);
                }
                return result;
            }
            this.handle = function(thunk) {
                var saved = [];
                var finalized = false;
                function installHandler(op, h) {
                    op.handler = function() {
                        return function(opCall) {
                            var returned = false;
                            // operation's arguments
                            var args = opCall.args;
                            // operation's continuation
                            var k = opCall.k;
                            var applyCont = function(v) {
                                // apply the operation's continuation
                                //var result = k(v);
                                var result = k(arguments[0]); // hack: workaround tailspin bug
                                if (!returned) { // return now if we haven't already
                                    result = _return(result);
                                }
                                return result;
                            }
                            var result = h.apply(null, args.concat(applyCont));
                            // fell thru - continuation not called
                            returned = true;
                            if (!finalized) {
                                finalized = true;
                                result = _finally(result);
                            }
                            return result;
                        }
                    }
                }
                // install handlers
                for (var i = 0; i < ops.length; i++) {
                    var op = ops[i];
                    saved.push(op.handler);
                    var h = hs[i];
                    installHandler(op, h);
                }
                // perform handling
                var result = metaCont.reset(function() {
                    var result = thunk();
                    result = _return(result);
                    return result;
                });
                // perform finally
                if (!finalized) {
                    result = _finally(result);
                }
                // restore previous handlers
                for (var i = 0; i < saved.length; i++) {
                    ops[i].handler = saved[i];
                }
                return result;
            }
        }

    }
    this.toString = function() {return "Eff"}
}


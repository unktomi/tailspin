function print(x) { console.log(x) }
var exit = new Continuation();

var Eff = new Effects();

// An effect which makes a binary choice
var Choice = Eff.createEffect("choice");

var decide = Choice.createOperation("decide");

function choice() {
    var x = decide() ?  40 : 10;
    var y = decide() ? 0 : 2;
    return x + y;
}

var chooseAll = {
    "return": function(x) { return [x] },
    "decide": function(k) { var xs = k(true); var ys = k(false); return xs.concat(ys); }
}

var h = Choice.createHandler(chooseAll);

print(h.handle(choice)); // prints 40,42,10,12

// Exceptions effect
var Exceptions = Eff.createEffect("exception");

var raise = Exceptions.createOperation("raise");

function Option() {
}

function None() {
    this.prototype = new Option();
    this.getOrElse = function(x) { return x }
    this.toString = function() {return "none"}
}

function Some(x) {
    this.prototype = new Option();
    this.getOrElse = function(_) { return x }
    this.toString = function() {return "some: "+JSON.stringify(x)}
}

var none = new None();

function some(x) { return new Some(x) }

var Exit = Exceptions.createHandler({
    "raise": function(e, k) { print("caught: "+e); exit(); }
});

var Optionalize = Exceptions.createHandler({
    "return": function(v) { return some(v) },
    "raise": function(v, k) { return (none) }
});


var result = Optionalize.handle(function() { return 42 });
print(result); // prints some: 42
result = Optionalize.handle(function() { raise("foo"); return 42 });
print(result); // prints none

// State effect
var State = Eff.createEffect("state");

var get = State.createOperation("get");
var set = State.createOperation("set");


function state(x) {
    return {
        "return": function(v) { return function(s) { return v; } },
        "get": function(k) { return function(s) { return k(s)(s) } },
        "set": function(v, k) { return function(s) { return k()(v) } },
        "finally": function(f) { var r = f(x); return r; }
    };
}

var h = State.createHandler(state(20))
result = h.handle(function()
                  {
                      var q = get();
                      set(q + 11);
                      var q2 = get();
                      return q2;
                  });
print(result); // prints 31




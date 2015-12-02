load("tailspin.js");

var tailspin = new Tailspin.Interpreter();

// Create an evaluation context that describes the how the code is to be executed.
var console = {
    log: function(x) { print(x) },
    error: function(x) { print(x) }
}


function readFile(file) {
    var r = new java.io.BufferedReader(new java.io.FileReader(file));
    var buf = new java.lang.StringBuffer();
    var line;
    while ((line = r.readLine()) instanceof String) {
        buf.append(line);
        buf.append("\n");
    }
    return String(buf.toString());
}

var file = arguments[0];

tailspin.global.console = {
    log:function(msg) {print(msg, 'log');}
};

tailspin.global.print = print;
tailspin.global.load = function(file) {
    run(file);
}


// Run the code.
function run(file) {
    var source = readFile(file);
    var x = tailspin.createExecutionContext();
    var result;
    fname = file;
    var lineno;
    var isDone = false;
    var t;
    var u;
    var tok;
    x.control = function(n, v, next, prev) {
        lineno = n.lineno;
        t = n;
        u = v;
        if (!isDone) {
            next(prev);
        }
    };
    tailspin.evaluateInContext(source, file, 0, x, function(r) {
        result = r;
        isDone = true;
    }, function(e) {
        var tok  = t != undefined ? source.substring(t.start, t.end) : "";
        console.error(fname+ ", Line "+lineno+": ERROR: " + result +": "+tok, 'error');
        isDone = true;
    }, null);
    return result;
}

run(file);

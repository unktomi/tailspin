/* -*- Mode: JS; tab-width: 4; indent-tabs-mode: nil; -*-
 * vim: set sw=4 ts=4 et tw=78:
 * ***** BEGIN LICENSE BLOCK *****
 *
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the Narcissus JavaScript engine.
 *
 * The Initial Developer of the Original Code is
 * Brendan Eich <brendan@mozilla.org>.
 * Portions created by the Initial Developer are Copyright (C) 2004
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Tom Austin <taustin@ucsc.edu>
 *   Brendan Eich <brendan@mozilla.org>
 *   Shu-Yu Guo <shu@rfrn.org>
 *   Dave Herman <dherman@mozilla.com>
 *   Dimitris Vardoulakis <dimvar@ccs.neu.edu>
 *   Patrick Walton <pcwalton@mozilla.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/*
 * Narcissus - JS implemented in JS.
 *
 * Parser.
 */

// Outer non-strict code.
// CUT>
(function () {

// Set constants in the local scope.
eval(Tailspin.Definitions.consts);
// <CUT

Tailspin.Parser = (function () {
"use strict";

var Tokenizer = Tailspin.Lexer.Tokenizer;

var Definitions = Tailspin.Definitions;
var Dict = Tailspin.Utility.Dict;
var Stack = Tailspin.Utility.Stack;


/*
 * pushDestructuringVarDecls :: (node, hoisting node) -> void
 *
 * Recursively add all destructured declarations to varDecls.
 */
function pushDestructuringVarDecls(n, s) {
    for (var i in n) {
        var sub = n[i];
        if (sub.type === IDENTIFIER) {
            s.varDecls.push(sub);
        } else {
            pushDestructuringVarDecls(sub, s);
        }
    }
}

function Parser(tokenizer) {
    tokenizer.parser = this;
    this.t = tokenizer;
    this.x = null;
    this.unexpectedEOF = false;
}

function StaticContext(parentScript, parentBlock, inFunction, strictMode) {
    this.parentScript = parentScript;
    this.parentBlock = parentBlock || parentScript;
    this.inFunction = inFunction || null;
    this.inForLoopInit = false;
    this.topLevel = true;
    this.allLabels = new Stack();
    this.currentLabels = new Stack();
    this.labeledTargets = new Stack();
    this.defaultLoopTarget = null;
    this.defaultTarget = null;
    this.strictMode = strictMode;
}

StaticContext.prototype = {
    // non-destructive update via prototype extension
    update: function(ext) {
        var desc = {};
        for (var key in ext) {
            desc[key] = {
                value: ext[key],
                writable: true,
                enumerable: true,
                configurable: true
            }
        }
        return Object.create(this, desc);
    },
    pushLabel: function(label) {
        return this.update({ currentLabels: this.currentLabels.push(label),
                             allLabels: this.allLabels.push(label) });
    },
    pushTarget: function(target) {
        var isDefaultLoopTarget = target.isLoop;
        var isDefaultTarget = isDefaultLoopTarget || target.type === SWITCH;

        if (this.currentLabels.isEmpty()) {
            if (isDefaultLoopTarget) this.update({ defaultLoopTarget: target });
            if (isDefaultTarget) this.update({ defaultTarget: target });
            return this;
        }

        target.labels = new Dict();
        this.currentLabels.forEach(function(label) {
            target.labels.set(label, true);
        });
        return this.update({ currentLabels: new Stack(),
                             labeledTargets: this.labeledTargets.push(target),
                             defaultLoopTarget: isDefaultLoopTarget
                             ? target
                             : this.defaultLoopTarget,
                             defaultTarget: isDefaultTarget
                             ? target
                             : this.defaultTarget });
    },
    nest: function() {
        return this.topLevel ? this.update({ topLevel: false }) : this;
    },
    banWith: function() {
        return this.strictMode;
    }
};

var Pp = Parser.prototype;

Pp.withContext = function(x, f) {
    var x0 = this.x;
    this.x = x;
    var result = f.call(this);
    // NB: we don't bother with finally, since exceptions trash the parser
    this.x = x0;
    return result;
};

Pp.newNode = function newNode(opts) {
    return new Node(this.t, opts);
};

Pp.fail = function fail(msg) {
    throw this.t.newSyntaxError(msg);
};

Pp.checkValidIdentifierIfStrict = function fail(type, value) {
    if (this.x.strictMode && (value === "eval" || value === "arguments")) {
        this.fail("Cannot declare a "+type+" named '"+value+"' in strict mode.");
    }
};

Pp.match = function match(tt, scanOperand, keywordIsName) {
    return this.t.match(tt, scanOperand, keywordIsName);
};

Pp.mustMatch = function mustMatch(tt, keywordIsName) {
    return this.t.mustMatch(tt, keywordIsName);
};

Pp.peek = function peek(scanOperand, keywordIsName) {
    return this.t.peek(scanOperand, keywordIsName);
};

Pp.peekOnSameLine = function peekOnSameLine(scanOperand) {
    return this.t.peekOnSameLine(scanOperand);
};

Pp.done = function done() {
    return this.t.done;
};

/*
 * Script :: (boolean, boolean, boolean) -> node
 *
 * Parses the toplevel and function bodies.
 */
Pp.Script = function Script(inFunction, expectEnd, strict) {
    var node = this.newNode(scriptInit());
    var x2 = new StaticContext(node, node, inFunction, strict);
    this.withContext(x2, function() {
        this.Statements(node, true);
    });
    if (expectEnd && !this.done())
        this.fail("expected end of input");
    return node;
};

/*
 * Pragma :: (expression statement node) -> boolean
 *
 * Checks whether a node is a pragma and annotates it.
 */
function Pragma(n) {
    if (n.type === SEMICOLON) {
        var e = n.expression;
        if (e && e.type === STRING) {
            // Checking the length of the string is a quick way of ensuring no escape sequences were used.
            if (e.value === "use strict" && e.end-e.start === "use strict".length+2) {
                n.pragma = "strict";
            }
            return true;
        }
    }
    return false;
}

/*
 * Node :: (tokenizer, optional init object) -> node
 */
function Node(t, init) {
    var token = t.token;
    if (token) {
        // If init.type exists it will override token.type.
        this.type = token.type;
        this.value = token.value;
        this.lineno = token.lineno;

        // Start and end are file positions for error handling.
        this.start = token.start;
        this.end = token.end;
    } else {
        this.lineno = t.lineno;
    }

    this.filename = t.filename;
    this.children = [];

    for (var prop in init)
        this[prop] = init[prop];
}

/*
 * SyntheticNode :: (optional init object) -> node
 */
function SyntheticNode(init) {
    this.children = [];
    for (var prop in init)
        this[prop] = init[prop];
    this.synthetic = true;
}

var Np = Node.prototype = SyntheticNode.prototype = {};
Np.constructor = Node;

var TO_SOURCE_SKIP = {
    type: true,
    value: true,
    lineno: true,
    start: true,
    end: true,
    tokenizer: true,
    assignOp: true
};
function unevalableConst(code) {
    var token = Definitions.tokens[code];
    var constName = Definitions.opTypeNames.hasOwnProperty(token)
        ? Definitions.opTypeNames[token]
        : Definitions.keywords.hasOwnProperty(token)
        ? token.toUpperCase()
        : token;
    return { toSource: function() { return constName } };
}
Np.toSource = function toSource() {
    var mock = {};
    var self = this;
    mock.type = unevalableConst(this.type);
    // avoid infinite recursion in case of back-links
    if (this.generatingSource)
        return mock.toSource();
    this.generatingSource = true;
    if ("value" in this)
        mock.value = this.value;
    if ("lineno" in this)
        mock.lineno = this.lineno;
    if ("start" in this)
        mock.start = this.start;
    if ("end" in this)
        mock.end = this.end;
    if (this.assignOp)
        mock.assignOp = unevalableConst(this.assignOp);
    for (var key in this) {
        if (this.hasOwnProperty(key) && !(key in TO_SOURCE_SKIP))
            mock[key] = this[key];
    }
    try {
        return mock.toSource();
    } finally {
        delete this.generatingSource;
    }
};

// Always use push to add operands to an expression, to update start and end.
Np.push = function (kid) {
    // kid can be null e.g. [1, , 2].
    if (kid !== null) {
        if (kid.start < this.start)
            this.start = kid.start;
        if (this.end < kid.end)
            this.end = kid.end;
    }
    return this.children.push(kid);
}

Node.indentLevel = 0;

function tokenString(tt) {
    var t = Definitions.tokens[tt];
    return /^\W/.test(t) ? Definitions.opTypeNames[t] : t.toUpperCase();
}

Np.toString = function () {
    var a = [];
    for (var i in this) {
        if (this.hasOwnProperty(i) && i !== 'type' && i !== 'target')
            a.push({id: i, value: this[i]});
    }
    a.sort(function (a,b) { return (a.id < b.id) ? -1 : 1; });
    var INDENTATION = "    ";
    var n = ++Node.indentLevel;
    var s = "{\n" + repeatString(INDENTATION, n) + "type: " + tokenString(this.type);
    for (i = 0; i < a.length; i++)
        s += ",\n" + repeatString(INDENTATION, n) + a[i].id + ": " + a[i].value;
    n = --Node.indentLevel;
    s += "\n" + repeatString(INDENTATION, n) + "}";
    return s;
}

Np.synth = function(init) {
    var node = new SyntheticNode(init);
    node.filename = this.filename;
    node.lineno = this.lineno;
    node.start = this.start;
    node.end = this.end;
    return node;
};

/*
 * Helper init objects for common nodes.
 */

var LOOP_INIT = { isLoop: true };

function blockInit() {
    return { type: BLOCK, varDecls: [] };
}

function scriptInit() {
    return { type: SCRIPT,
             funDecls: [],
             varDecls: [],
             modDefns: new Dict(),
             modAssns: new Dict(),
             modDecls: new Dict(),
             modLoads: new Dict(),
             impDecls: [],
             expDecls: [],
             hasEmptyReturn: false,
             hasReturnWithValue: false };
}

function repeatString(str, n) {
   var s = "", t = str + s;
   while (--n >= 0) {
       s += t;
   }
   return s;
}

Pp.MaybeLeftParen = function MaybeLeftParen() {
    return this.mustMatch(LEFT_PAREN).type;
};

Pp.MaybeRightParen = function MaybeRightParen(p) {
    if (p === LEFT_PAREN)
        this.mustMatch(RIGHT_PAREN);
}

Pp.checkContextForStrict = function() {
    // Ensure the previous pragmas are valid in strict mode.
    var pragmas = this.x.parentBlock.children;
    for (var i=0, c=pragmas.length-1; i<c; i++) {
        eval('"use strict"; '+this.t.source.substring(pragmas[i].start, pragmas[i].end));
    }
    
    // Check identifiers are valid in strict mode.
    if (this.x.inFunction) {
        this.checkValidIdentifierIfStrict("function", this.x.inFunction.name);
        var params = this.x.inFunction.params;
        for (var i=0, c=params.length; i<c; i++) {
            this.checkValidIdentifierIfStrict("parameter", params[i]);
            if (params.indexOf(params[i]) !== i) {
                this.fail("Cannot declare a parameter named '"+params[i]+
                    "' more than once in strict mode");
            }
        }
    }
}

/*
 * Statements :: (node[, boolean]) -> void
 *
 * Parses a sequence of Statements.
 */
Pp.Statements = function Statements(n, topLevel) {
    var prologue = !!topLevel;
    try {
        if (this.x.strictMode) {
            n.strict = true;
        }
        while (!this.done() && this.peek(true) !== RIGHT_CURLY) {
            var n2 = this.Statement();
            n.push(n2);
            if (prologue && Pragma(n2)) {
                if (n2.pragma === "strict") {
                    this.x.strictMode = true;
                    n.strict = true;
                    this.checkContextForStrict();
                }
            }
            else {
                prologue = false;
            }
        }
    } catch (e) {
        if (this.done())
            this.unexpectedEOF = true;
        throw e;
    }
}

Pp.Block = function Block() {
    this.mustMatch(LEFT_CURLY);
    var n = this.newNode(blockInit());
    var x2 = this.x.update({ parentBlock: n }).pushTarget(n);
    this.withContext(x2, function() {
        this.Statements(n);
    });
    this.mustMatch(RIGHT_CURLY);
    return n;
}

var DECLARED_FORM = 0, EXPRESSED_FORM = 1, STATEMENT_FORM = 2;

/*
 * Statement :: () -> node
 *
 * Parses a Statement.
 */
Pp.Statement = function Statement() {
    var i, label, n, n2, p, c, ss, tt = this.t.get(true), tt2, x0, x2, x3;

    var comments = this.t.blockComments;

    // Cases for statements ending in a right curly return early, avoiding the
    // common semicolon insertion magic after this switch.
    switch (tt) {
      case FUNCTION:
        // DECLARED_FORM extends funDecls of x, STATEMENT_FORM doesn't.
        return this.FunctionDefinition(true, this.x.topLevel ? DECLARED_FORM : STATEMENT_FORM, comments);

      case LEFT_CURLY:
        n = this.newNode(blockInit());
        x2 = this.x.update({ parentBlock: n }).pushTarget(n).nest();
        this.withContext(x2, function() {
            this.Statements(n);
        });
        this.mustMatch(RIGHT_CURLY);
        return n;

      case IF:
        n = this.newNode();
        n.condition = this.HeadExpression();
        x2 = this.x.pushTarget(n).nest();
        this.withContext(x2, function() {
            n.thenPart = this.Statement();
            n.elsePart = this.match(ELSE, true) ? this.Statement() : null;
        });
        return n;

      case SWITCH:
        // This allows CASEs after a DEFAULT, which is in the standard.
        n = this.newNode({ cases: [], defaultIndex: -1 });
        n.discriminant = this.HeadExpression();
        x2 = this.x.pushTarget(n).nest();
        this.withContext(x2, function() {
            this.mustMatch(LEFT_CURLY);
            while ((tt = this.t.get()) !== RIGHT_CURLY) {
                switch (tt) {
                  case DEFAULT:
                    if (n.defaultIndex >= 0)
                        this.fail("More than one switch default");
                    // FALL THROUGH
                  case CASE:
                    n2 = this.newNode();
                    if (tt === DEFAULT)
                        n.defaultIndex = n.cases.length;
                    else
                        n2.caseLabel = this.Expression(COLON);
                    break;

                  default:
                    this.fail("Invalid switch case");
                }
                this.mustMatch(COLON);
                n2.statements = this.newNode(blockInit());
                while ((tt=this.peek(true)) !== CASE && tt !== DEFAULT &&
                       tt !== RIGHT_CURLY)
                    n2.statements.push(this.Statement());
                n.cases.push(n2);
            }
        });
        return n;

      case FOR:
        n = this.newNode(LOOP_INIT);
        n.blockComments = comments;
        this.mustMatch(LEFT_PAREN);
        x2 = this.x.pushTarget(n).nest();
        x3 = this.x.update({ inForLoopInit: true });
        n2 = null;
        if ((tt = this.peek(true)) !== SEMICOLON) {
            this.withContext(x3, function() {
                if (tt === VAR || tt === CONST) {
                    this.t.get();
                    n2 = this.Variables();
                }
                else {
                    n2 = this.Expression();
                }
            });
        }
        if (n2 && this.match(IN)) {
            n.type = FOR_IN;
            this.withContext(x3, function() {
                n.object = this.Expression();
                if (n2.type === VAR) {
                    c = n2.children;

                    // Destructuring turns one decl into multiples, so either
                    // there must be only one destructuring or only one
                    // decl.
                    if (c.length !== 1 && n2.destructurings.length !== 1) {
                        // FIXME: this.fail ?
                        this.fail("Invalid for..in left-hand side",
                                              this.filename, n2.lineno);
                    }
                    if (n2.destructurings.length > 0) {
                        n.iterator = n2.destructurings[0];
                    } else {
                        n.iterator = c[0];
                    }
                    n.varDecl = n2;
                } else {
                    if (n2.type === ARRAY_INIT || n2.type === OBJECT_INIT) {
                        n2.destructuredNames = this.checkDestructuring(n2);
                    }
                    n.iterator = n2;
                }
            });
        } else {
            x3.inForLoopInit = false;
            n.setup = n2;
            this.mustMatch(SEMICOLON);
            this.withContext(x3, function() {
                n.condition = (this.peek(true) === SEMICOLON)
                    ? null
                    : this.Expression();
                this.mustMatch(SEMICOLON);
                tt2 = this.peek(true);
                n.update = tt2 === RIGHT_PAREN? null : this.Expression();
            });
        }
        this.mustMatch(RIGHT_PAREN);
        this.withContext(x2, function() {
            n.body = this.Statement();
        });
        return n;

      case WHILE:
        n = this.newNode({ isLoop: true });
        n.blockComments = comments;
        n.condition = this.HeadExpression();
        x2 = this.x.pushTarget(n).nest();
        this.withContext(x2, function() {
            n.body = this.Statement();
        });
        return n;

      case DO:
        n = this.newNode({ isLoop: true });
        n.blockComments = comments;
        x2 = this.x.pushTarget(n).nest();
        this.withContext(x2, function() {
            n.body = this.Statement();
        });
        this.mustMatch(WHILE);
        n.condition = this.HeadExpression();
        // <script language="JavaScript"> (without version hints) may need
        // automatic semicolon insertion without a newline after do-while.
        // See http://bugzilla.mozilla.org/show_bug.cgi?id=238945.
        this.match(SEMICOLON);
        return n;

      case BREAK:
      case CONTINUE:
        n = this.newNode();
        n.blockComments = comments;

        // handle the |foo: break foo;| corner case
        x2 = this.x.pushTarget(n);

        if (this.peekOnSameLine() === IDENTIFIER) {
            this.t.get();
            n.label = this.t.token.value;
        }

        if (n.label) {
            n.target = x2.labeledTargets.find(function(target) {
                return target.labels.has(n.label)
            });
        } else if (tt === CONTINUE) {
            n.target = x2.defaultLoopTarget;
        } else {
            n.target = x2.defaultTarget;
        }

        if (!n.target)
            this.fail("Invalid " + ((tt === BREAK) ? "break" : "continue"));
        if (!n.target.isLoop && tt === CONTINUE)
            this.fail("Invalid continue");

        break;

      case TRY:
        n = this.newNode({ catchClauses: [] });
        n.blockComments = comments;
        n.tryBlock = this.Block();
        while (this.match(CATCH)) {
            n2 = this.newNode();
            this.mustMatch(LEFT_PAREN);
            switch (this.t.get()) {
              case LEFT_BRACKET:
              case LEFT_CURLY:
                // Destructured catch identifiers.
                this.t.unget();
                n2.varName = this.DestructuringExpression(true);
                break;
              case IDENTIFIER:
                n2.varName = this.t.token.value;
                this.checkValidIdentifierIfStrict("parameter", this.t.token.value);
                break;
              default:
                this.fail("missing identifier in catch");
                break;
            }
            this.mustMatch(RIGHT_PAREN);
            n2.block = this.Block();
            n.catchClauses.push(n2);
        }
        if (this.match(FINALLY))
            n.finallyBlock = this.Block();
        if (!n.catchClauses.length && !n.finallyBlock)
            this.fail("Invalid try statement");
        return n;

      case CATCH:
      case FINALLY:
        this.fail(Definitions.tokens[tt] + " without preceding try");

      case THROW:
        n = this.newNode();
        n.exception = this.Expression();
        break;

      case RETURN:
        n = this.Return();
        break;

      case WITH:
        if (this.x.banWith()) {
            this.fail("with statements not allowed in strict code");
        }
        n = this.newNode();
        n.blockComments = comments;
        n.object = this.HeadExpression();
        x2 = this.x.pushTarget(n).nest();
        this.withContext(x2, function() {
            n.body = this.Statement();
        });
        return n;

      case VAR:
      case CONST:
        n = this.Variables();
        break;

      case DEBUGGER:
        n = this.newNode();
        break;

      case NEWLINE:
      case SEMICOLON:
        n = this.newNode({ type: SEMICOLON });
        n.blockComments = comments;
        n.expression = null;
        return n;

      case IDENTIFIER:
        tt = this.peek();
        // Labeled statement.
        if (tt === COLON) {
            label = this.t.token.value;
            if (this.x.allLabels.has(label))
                this.fail("Duplicate label: " + label);
            this.t.get();
            n = this.newNode({ type: LABEL, label: label });
            n.blockComments = comments;
            x2 = this.x.pushLabel(label).nest();
            this.withContext(x2, function() {
                n.statement = this.Statement();
            });
            n.target = (n.statement.type === LABEL) ? n.statement.target : n.statement;
            return n;
        }
        // FALL THROUGH

      default:
        // Expression statement.
        // We unget the current token to parse the expression as a whole.
        n = this.newNode({ type: SEMICOLON });
        this.t.unget();
        n.blockComments = comments;
        n.expression = this.Expression();
        n.end = n.expression.end;
        break;
    }

    n.blockComments = comments;
    this.MagicalSemicolon();
    return n;
}

/*
 * isPragmaToken :: (number) -> boolean
 */
function isPragmaToken(tt) {
    switch (tt) {
      case IDENTIFIER:
      case STRING:
      case NUMBER:
      case NULL:
      case TRUE:
      case FALSE:
        return true;
    }
    return false;
}

/*
 * Pragmas :: () -> Array[Array[token]]
 */
Pp.Pragmas = function Pragmas() {
    var pragmas = [];
    do {
        pragmas.push(this.Pragma());
    } while (this.match(COMMA));
    this.MagicalSemicolon();
    return pragmas;
}

/*
 * Pragmas :: () -> Array[token]
 */
Pp.Pragma = function Pragma() {
    var items = [];
    var tt;
    do {
        tt = this.t.get(true);
        items.push(this.t.token);
    } while (isPragmaToken(this.peek()));
    return items;
}

/*
 * MagicalSemicolon :: () -> void
 */
Pp.MagicalSemicolon = function MagicalSemicolon() {
    var tt;
    if (this.t.lineno === this.t.token.lineno) {
        tt = this.peekOnSameLine();
        if (tt !== END && tt !== NEWLINE && tt !== SEMICOLON && tt !== RIGHT_CURLY)
            this.fail("missing ; before statement");
    }
    this.match(SEMICOLON);
}

/*
 * Return :: () -> (RETURN) node
 */
Pp.Return = function Return() {
    var parentScript = this.x.parentScript;

    if (!this.x.inFunction) {
        this.fail("Return not in function");
    }
    
    var n = this.newNode({ value: undefined });

    var tt2 = this.peekOnSameLine(true);
    if (tt2 !== END && tt2 !== NEWLINE && tt2 !== SEMICOLON && tt2 !== RIGHT_CURLY) {
        n.value = this.Expression();
        parentScript.hasReturnWithValue = true;
    }
    else {
        parentScript.hasEmptyReturn = true;
    }

    return n;
}


/*
 * ExplicitSpecifierSet :: (() -> node) -> OBJECT_INIT node
 */
Pp.ExplicitSpecifierSet = function ExplicitSpecifierSet(SpecifierRHS) {
    var n, n2, id, tt;

    n = this.newNode({ type: OBJECT_INIT });
    this.mustMatch(LEFT_CURLY);

    if (!this.match(RIGHT_CURLY)) {
        do {
            id = this.Identifier();
            if (this.match(COLON)) {
                n2 = this.newNode({ type: PROPERTY_INIT });
                n2.push(id);
                n2.push(SpecifierRHS());
                n.push(n2);
            } else {
                n.push(id);
            }
        } while (!this.match(RIGHT_CURLY) && this.mustMatch(COMMA));
    }

    return n;
}


/*
 * Identifier :: () -> IDENTIFIER node
 */
Pp.Identifier = function Identifier() {
    this.mustMatch(IDENTIFIER);
    return this.newNode({ type: IDENTIFIER });
}

/*
 * IdentifierName :: () -> IDENTIFIER node
 */
Pp.IdentifierName = function IdentifierName() {
    this.mustMatch(IDENTIFIER, true);
    return this.newNode({ type: IDENTIFIER });
}

/*
 * QualifiedPath :: () -> (IDENTIFIER | DOT) node
 */
Pp.QualifiedPath = function QualifiedPath() {
    var n, n2;

    n = this.Identifier();

    while (this.match(DOT)) {
        if (this.peek() !== IDENTIFIER) {
            // Unget the '.' token, which isn't part of the QualifiedPath.
            this.t.unget();
            break;
        }
        n2 = this.newNode();
        n2.push(n);
        n2.push(this.Identifier());
        n = n2;
    }

    return n;
}


/*
 * FunctionDefinition :: (boolean,
 *                        DECLARED_FORM or EXPRESSED_FORM or STATEMENT_FORM,
 *                        [string] or null or undefined)
 *                    -> node
 */
Pp.FunctionDefinition = function FunctionDefinition(requireName, functionForm, comments, keywordIsName) {
    var tt;
    var f = this.newNode({ params: [], paramComments: [] });
    if (typeof comments === "undefined")
        comments = null;
    f.blockComments = comments;
    if (f.type !== FUNCTION)
        f.type = (f.value === "get") ? GETTER : SETTER;
    if (this.match(IDENTIFIER, false, keywordIsName)) {
        f.name = this.t.token.value;
        this.checkValidIdentifierIfStrict("function", f.name);
    }
    else if (requireName)
        this.fail("missing function identifier");

    var x2 = new StaticContext(null, null, f, this.x.strictMode);
    this.withContext(x2, function() {
        this.mustMatch(LEFT_PAREN);
        if (!this.match(RIGHT_PAREN)) {
            do {
                tt = this.t.get();
                f.paramComments.push(this.t.lastBlockComment());
                switch (tt) {
                  case LEFT_BRACKET:
                  case LEFT_CURLY:
                    // Destructured formal parameters.
                    this.t.unget();
                    f.params.push(this.DestructuringExpression());
                    break;
                  case IDENTIFIER:
                    // strict checks for name and duplication
                    if (this.x.strictMode) {
                        this.checkValidIdentifierIfStrict("parameter", this.t.token.value);
                        if (f.params.indexOf(this.t.token.value) !== -1) {
                            this.fail("Cannot declare a parameter named '"+this.t.token.value+
                                "' more than once in strict mode");
                        }
                    }
                    f.params.push(this.t.token.value);
                    break;
                  default:
                    this.fail("missing formal parameter");
                }
            } while (this.match(COMMA));
            this.mustMatch(RIGHT_PAREN);
        }

        // Do we have an expression closure or a normal body?
        tt = this.t.get(true);
        if (tt !== LEFT_CURLY)
            this.t.unget();

        if (tt !== LEFT_CURLY) {
            f.body = this.AssignExpression();
        } else {
            f.body = this.Script(f, false, x2.strictMode);
        }
    });

    if (tt === LEFT_CURLY)
        this.mustMatch(RIGHT_CURLY);

    f.end = this.t.token.end;
    f.functionForm = functionForm;
    if (functionForm === DECLARED_FORM)
        this.x.parentScript.funDecls.push(f);

    return f;
}


/*
 * Variables :: () -> node
 *
 * Parses a comma-separated list of var declarations (and maybe
 * initializations).
 */
Pp.Variables = function Variables() {
    var n, n2, ss, i, s, tt;

    tt = this.t.token.type;
    switch (tt) {
      case VAR:
      case CONST:
        s = this.x.parentScript;
        break;
    }

    n = this.newNode({ type: tt, destructurings: [] });

    do {
        tt = this.t.get();
        if (tt === LEFT_BRACKET || tt === LEFT_CURLY) {
            // Need to unget to parse the full destructured expression.
            this.t.unget();

            var dexp = this.DestructuringExpression(true);

            n2 = this.newNode({ type: IDENTIFIER,
                                name: dexp,
                                readOnly: n.type === CONST });
            n.push(n2);
            pushDestructuringVarDecls(n2.name.destructuredNames, s);
            n.destructurings.push({ exp: dexp, decl: n2 });

            if (this.x.inForLoopInit && this.peek() === IN) {
                continue;
            }

            this.mustMatch(ASSIGN);
            if (this.t.token.assignOp)
                this.fail("Invalid variable initialization");

            n2.blockComment = this.t.lastBlockComment();
            n2.initializer = this.AssignExpression();

            continue;
        }

        if (tt !== IDENTIFIER)
            this.fail("missing variable name");
        
        this.checkValidIdentifierIfStrict("variable", this.t.token.value);

        n2 = this.newNode({ type: IDENTIFIER,
                            name: this.t.token.value,
                            readOnly: n.type === CONST });
        n.push(n2);
        s.varDecls.push(n2);

        if (this.match(ASSIGN)) {
            var comment = this.t.lastBlockComment();
            if (this.t.token.assignOp)
                this.fail("Invalid variable initialization");

            n2.initializer = this.AssignExpression();
        } else {
            var comment = this.t.lastBlockComment();
        }
        n2.blockComment = comment;
    } while (this.match(COMMA));

    return n;
}

Pp.checkDestructuring = function checkDestructuring(n, simpleNamesOnly) {
    if (n.type === ARRAY_COMP)
        this.fail("Invalid array comprehension left-hand side");
    if (n.type !== ARRAY_INIT && n.type !== OBJECT_INIT)
        return;

    var lhss = {};
    var nn, n2, idx, sub, cc, c = n.children;
    for (var i = 0, j = c.length; i < j; i++) {
        if (!(nn = c[i]))
            continue;
        if (nn.type === PROPERTY_INIT) {
            cc = nn.children;
            sub = cc[1];
            idx = cc[0].value;
        } else if (n.type === OBJECT_INIT) {
            // Do we have destructuring shorthand {foo, bar}?
            sub = nn;
            idx = nn.value;
        } else {
            sub = nn;
            idx = i;
        }

        if (sub.type === ARRAY_INIT || sub.type === OBJECT_INIT) {
            lhss[idx] = this.checkDestructuring(sub, simpleNamesOnly);
        } else {
            if (simpleNamesOnly && sub.type !== IDENTIFIER) {
                // In declarations, lhs must be simple names
                this.fail("missing name in pattern");
            }

            lhss[idx] = sub;
        }
    }

    return lhss;
}

Pp.DestructuringExpression = function DestructuringExpression(simpleNamesOnly) {
    var n = this.PrimaryExpression();
    // Keep the list of lefthand sides for varDecls
    n.destructuredNames = this.checkDestructuring(n, simpleNamesOnly);
    return n;
}

Pp.ComprehensionTail = function ComprehensionTail() {
    var body, n, n2, n3;

    // t.token.type must be FOR
    body = this.newNode({ type: COMP_TAIL });

    do {
        // Comprehension tails are always for..in loops.
        n = this.newNode({ type: FOR_IN, isLoop: true });
        this.mustMatch(LEFT_PAREN);
        switch(this.t.get()) {
          case LEFT_BRACKET:
          case LEFT_CURLY:
            this.t.unget();
            // Destructured left side of for in comprehension tails.
            n.iterator = this.DestructuringExpression();
            break;

          case IDENTIFIER:
            n.iterator = n3 = this.newNode({ type: IDENTIFIER });
            n3.name = n3.value;
            n.varDecl = n2 = this.newNode({ type: VAR });
            n2.push(n3);
            this.x.parentScript.varDecls.push(n3);
            // Don't add to varDecls since the semantics of comprehensions is
            // such that the variables are in their own function when
            // desugared.
            break;

          default:
            this.fail("missing identifier");
        }
        this.mustMatch(IN);
        n.object = this.Expression();
        this.mustMatch(RIGHT_PAREN);
        body.push(n);
    } while (this.match(FOR));

    // Optional guard.
    if (this.match(IF))
        body.guard = this.HeadExpression();

    return body;
}

Pp.HeadExpression = function HeadExpression() {
    this.mustMatch(LEFT_PAREN);
    var n = this.ParenExpression();
    this.mustMatch(RIGHT_PAREN);
    return n;
}

Pp.ParenExpression = function ParenExpression() {
    // Always accept the 'in' operator in a parenthesized expression,
    // where it's unambiguous, even if we might be parsing the init of a
    // for statement.
    var x2 = this.x.update({
        inForLoopInit: this.x.inForLoopInit && (this.t.token.type === LEFT_PAREN)
    });
    var n = this.withContext(x2, function() {
        return this.Expression();
    });

    return n;
}

/*
 * Expression :: () -> node
 *
 * Top-down expression parser matched against SpiderMonkey.
 */
Pp.Expression = function Expression() {
    var n, n2;

    n = this.AssignExpression();
    if (this.match(COMMA)) {
        n2 = this.newNode({ type: COMMA });
        n2.push(n);
        n = n2;
        do {
            n2 = n.children[n.children.length-1];
            n.push(this.AssignExpression());
        } while (this.match(COMMA));
    }

    return n;
}

Pp.AssignExpression = function AssignExpression() {
    var n, lhs;

    lhs = this.ConditionalExpression();

    if (!this.match(ASSIGN)) {
        return lhs;
    }

    n = this.newNode({ type: ASSIGN });
    n.blockComment = this.t.lastBlockComment();

    switch (lhs.type) {
      case OBJECT_INIT:
      case ARRAY_INIT:
        lhs.destructuredNames = this.checkDestructuring(lhs);
        // FALL THROUGH
      case IDENTIFIER:
        this.checkValidIdentifierIfStrict("variable", lhs.value);
        break;
      case DOT: case INDEX: case CALL:
        break;
      case NUMBER: case STRING: case TRUE: case FALSE: case NULL:
        throw this.t.newReferenceError("Bad left-hand side of assignment");
        break;
      default:
        this.fail("Bad left-hand side of assignment");
        break;
    }

    n.assignOp = lhs.assignOp = this.t.token.assignOp;
    n.push(lhs);
    n.push(this.AssignExpression());

    return n;
}

Pp.ConditionalExpression = function ConditionalExpression() {
    var n, n2;

    n = this.OrExpression();
    if (this.match(HOOK)) {
        n2 = n;
        n = this.newNode({ type: HOOK });
        n.push(n2);
        /*
         * Always accept the 'in' operator in the middle clause of a ternary,
         * where it's unambiguous, even if we might be parsing the init of a
         * for statement.
         */
        var x2 = this.x.update({ inForLoopInit: false });
        this.withContext(x2, function() {
            n.push(this.AssignExpression());
        });
        if (!this.match(COLON))
            this.fail("missing : after ?");
        n.push(this.AssignExpression());
    }

    return n;
}

Pp.OrExpression = function OrExpression() {
    var n, n2;

    n = this.AndExpression();
    while (this.match(OR)) {
        n2 = this.newNode();
        n2.push(n);
        n2.push(this.AndExpression());
        n = n2;
    }

    return n;
}

Pp.AndExpression = function AndExpression() {
    var n, n2;

    n = this.BitwiseOrExpression();
    while (this.match(AND)) {
        n2 = this.newNode();
        n2.push(n);
        n2.push(this.BitwiseOrExpression());
        n = n2;
    }

    return n;
}

Pp.BitwiseOrExpression = function BitwiseOrExpression() {
    var n, n2;

    n = this.BitwiseXorExpression();
    while (this.match(BITWISE_OR)) {
        n2 = this.newNode();
        n2.push(n);
        n2.push(this.BitwiseXorExpression());
        n = n2;
    }

    return n;
}

Pp.BitwiseXorExpression = function BitwiseXorExpression() {
    var n, n2;

    n = this.BitwiseAndExpression();
    while (this.match(BITWISE_XOR)) {
        n2 = this.newNode();
        n2.push(n);
        n2.push(this.BitwiseAndExpression());
        n = n2;
    }

    return n;
}

Pp.BitwiseAndExpression = function BitwiseAndExpression() {
    var n, n2;

    n = this.EqualityExpression();
    while (this.match(BITWISE_AND)) {
        n2 = this.newNode();
        n2.push(n);
        n2.push(this.EqualityExpression());
        n = n2;
    }

    return n;
}

Pp.EqualityExpression = function EqualityExpression() {
    var n, n2;

    n = this.RelationalExpression();
    while (this.match(EQ) || this.match(NE) ||
           this.match(STRICT_EQ) || this.match(STRICT_NE)) {
        n2 = this.newNode();
        n2.push(n);
        n2.push(this.RelationalExpression());
        n = n2;
    }

    return n;
}

Pp.RelationalExpression = function RelationalExpression() {
    var n, n2;

    n = this.ShiftExpression();
    while ((this.match(LT) || this.match(LE) || this.match(GE) || this.match(GT) ||
            (!this.x.inForLoopInit && this.match(IN)) ||
            this.match(INSTANCEOF))) {
        n2 = this.newNode();
        n2.push(n);
        n2.push(this.ShiftExpression());
        n = n2;
    }

    return n;
}

Pp.ShiftExpression = function ShiftExpression() {
    var n, n2;

    /*
     * Uses of the in operator in shiftExprs are always unambiguous,
     * so unset the flag that prohibits recognizing it.
     */
    var x2 = this.x.update({ inForLoopInit: false });
    this.withContext(x2, function() {
        n = this.AddExpression();
        while (this.match(LSH) || this.match(RSH) || this.match(URSH)) {
            n2 = this.newNode();
            n2.push(n);
            n2.push(this.AddExpression());
            n = n2;
        }
    });

    return n;
}

Pp.AddExpression = function AddExpression() {
    var n, n2;

    n = this.MultiplyExpression();
    while (this.match(PLUS) || this.match(MINUS)) {
        n2 = this.newNode();
        n2.push(n);
        n2.push(this.MultiplyExpression());
        n = n2;
    }

    return n;
}

Pp.MultiplyExpression = function MultiplyExpression() {
    var n, n2;

    n = this.UnaryExpression();
    while (this.match(MUL) || this.match(DIV) || this.match(MOD)) {
        n2 = this.newNode();
        n2.push(n);
        n2.push(this.UnaryExpression());
        n = n2;
    }

    return n;
}

Pp.UnaryExpression = function UnaryExpression() {
    var n, n2, tt;

    switch (tt = this.t.get(true)) {
      case DELETE: case VOID: case TYPEOF:
      case NOT: case BITWISE_NOT: case PLUS: case MINUS:
        if (tt === PLUS)
            n = this.newNode({ type: UNARY_PLUS });
        else if (tt === MINUS)
            n = this.newNode({ type: UNARY_MINUS });
        else
            n = this.newNode();
        
        n2 = this.UnaryExpression();
        n.push(n2);
        
        if (tt === DELETE && this.x.strictMode && !(n2.type === DOT || n2.type === INDEX)) {
            this.fail("Cannot delete unqualified property '"+n2.value+"' in strict mode");
        }
        break;

      case INCREMENT:
      case DECREMENT:
        // Prefix increment/decrement.
        n = this.newNode();
        n.push(this.MemberExpression(true));
        this.checkValidIdentifierIfStrict("variable", n.children[0].value);
        break;

      default:
        this.t.unget();
        n = this.MemberExpression(true);

        // Don't look across a newline boundary for a postfix {in,de}crement.
        if (this.t.tokens[(this.t.tokenIndex + this.t.lookahead - 1) & 3].lineno ===
            this.t.lineno) {
            if (this.match(INCREMENT) || this.match(DECREMENT)) {
                this.checkValidIdentifierIfStrict("variable", n.value);
                n2 = this.newNode({ postfix: true });
                n2.push(n);
                n = n2;
            }
        }
        break;
    }

    return n;
}

Pp.MemberExpression = function MemberExpression(allowCallSyntax) {
    var n, n2, name, tt;

    if (this.match(NEW)) {
        n = this.newNode();
        n.push(this.MemberExpression(false));
        if (this.match(LEFT_PAREN)) {
            n.type = NEW_WITH_ARGS;
            n.push(this.ArgumentList());
        }
    } else {
        n = this.PrimaryExpression();
    }

    while ((tt = this.t.get()) !== END) {
        switch (tt) {
          case DOT:
            n2 = this.newNode();
            n2.push(n);
            n2.push(this.IdentifierName());
            break;

          case LEFT_BRACKET:
            n2 = this.newNode({ type: INDEX });
            n2.push(n);
            n2.push(this.Expression());
            this.mustMatch(RIGHT_BRACKET);
            break;

          case LEFT_PAREN:
            if (allowCallSyntax) {
                n2 = this.newNode({ type: CALL });
                n2.push(n);
                n2.push(this.ArgumentList());
                break;
            }

            // FALL THROUGH
          default:
            this.t.unget();
            return n;
        }

        n = n2;
    }

    return n;
}

Pp.ArgumentList = function ArgumentList() {
    var n, n2;

    n = this.newNode({ type: LIST });
    if (this.match(RIGHT_PAREN, true))
        return n;
    do {
        n2 = this.AssignExpression();
        n.push(n2);
    } while (this.match(COMMA));
    this.mustMatch(RIGHT_PAREN);

    return n;
}

Pp.PrimaryExpression = function PrimaryExpression() {
    var n, n2, tt = this.t.get(true);

    switch (tt) {
      case FUNCTION:
        n = this.FunctionDefinition(false, EXPRESSED_FORM);
        break;

      case LEFT_BRACKET:
        n = this.newNode({ type: ARRAY_INIT });
        while ((tt = this.peek(true)) !== RIGHT_BRACKET) {
            if (tt === COMMA) {
                this.t.get();
                n.push(null);
                continue;
            }
            n.push(this.AssignExpression());
            if (tt !== COMMA && !this.match(COMMA))
                break;
        }

        // If we matched exactly one element and got a FOR, we have an
        // array comprehension.
        if (n.children.length === 1 && this.match(FOR)) {
            n2 = this.newNode({ type: ARRAY_COMP,
                                expression: n.children[0],
                                tail: this.ComprehensionTail() });
            n = n2;
        }
        this.mustMatch(RIGHT_BRACKET);
        break;

      case LEFT_CURLY:
        var id, fd;
        var idTypes = {}; // bit flags 1:value 2:getter 4:setter
        n = this.newNode({ type: OBJECT_INIT });

        object_init:
        if (!this.match(RIGHT_CURLY)) {
            do {
                tt = this.t.get();
                var tokenValue = this.t.token.value;
                if ((tokenValue === "get" || tokenValue === "set") &&
                    this.peek(false, true) === IDENTIFIER) {
                    var fn = this.FunctionDefinition(true, EXPRESSED_FORM, null, true);
                    
                    // Check idTypes for duplicate definitions of key.
                    if (idTypes[fn.name] & 1) {
                        this.fail("cannot create object with '"+fn.name+"' and '"+tokenValue+" "+fn.name+"'");
                    }
                    if (idTypes[fn.name] & (tokenValue === "get"? 2 : 4)) {
                        this.fail("cannot create object with multiple '"+tokenValue+" "+fn.name+"' values");
                    }
                    idTypes[fn.name] = (idTypes[fn.name] || 0) | (tokenValue === "get"? 2 : 4); // add get/set flag
                    
                    n.push(fn);
                } else {
                    var comments = this.t.blockComments;
                    switch (tt) {
                      case IDENTIFIER: case NUMBER: case STRING:
                        id = this.newNode({ type: IDENTIFIER });
                        break;
                      case RIGHT_CURLY:
                        break object_init;
                      default:
                        if (Definitions.keywords.hasOwnProperty(this.t.token.value)) {
                            id = this.newNode({ type: IDENTIFIER });
                            break;
                        }
                        this.fail("Invalid property name");
                    }
                    if (this.match(COLON)) {
                        n2 = this.newNode({ type: PROPERTY_INIT });
                        n2.push(id);
                        n2.push(this.AssignExpression());
                        n2.blockComments = comments;
                        
                        // Check idTypes for duplicate definitions of key.
                        if (idTypes[id.value] & 2) {
                            this.fail("cannot create object with 'get "+id.value+"' and '"+id.value+"'");
                        }
                        if (idTypes[id.value] & 4) {
                            this.fail("cannot create object with 'set "+id.value+"' and '"+id.value+"'");
                        }
                        if (this.x.strictMode && (idTypes[id.value] & 1)) {
                            this.fail("cannot create object with multiple '"+id.value+"' values");
                        }
                        idTypes[id.value] = (idTypes[id.value] || 0) | 1; // add value flag
                        
                        n.push(n2);
                    } else {
                        // Support, e.g., |var {x, y} = o| as destructuring shorthand
                        // for |var {x: x, y: y} = o|, per proposed JS2/ES4 for JS1.8.
                        if (this.peek() !== COMMA && this.peek() !== RIGHT_CURLY)
                            this.fail("missing : after property");
                        n.push(id);
                    }
                }
            } while (this.match(COMMA));
            this.mustMatch(RIGHT_CURLY);
        }
        break;

      case LEFT_PAREN:
        n = this.ParenExpression();
        this.mustMatch(RIGHT_PAREN);
        n.parenthesized = true;
        break;
      
      case NULL: case THIS: case TRUE: case FALSE:
      case IDENTIFIER: case NUMBER: case STRING: case REGEXP:
        n = this.newNode();
        break;

      default:
        this.fail("missing operand; found " + Definitions.tokens[tt]);
        break;
    }

    return n;
}

/*
 * parse :: (source, filename, line number, boolean, sandbox) -> node
 */
function parse(source, filename, lineno, strict, sandbox) {
    var tokenizer = new Tokenizer(source, filename, lineno, sandbox);
    var parser = new Parser(tokenizer);
    return parser.Script(null, true, strict);
}

/*
 * parseFunction :: (source, boolean,
 *                   DECLARED_FORM or EXPRESSED_FORM or STATEMENT_FORM,
 *                   filename, line number)
 *               -> node
 */
function parseFunction(source, requireName, form, filename, lineno, sandbox) {
    var t = new Tokenizer(source, filename, lineno, sandbox);
    var p = new Parser(t);
    p.x = new StaticContext(null, null, null, false);
    return p.FunctionDefinition(requireName, form);
}

var exports = {};
exports.parse = parse;
exports.parseFunction = parseFunction;
exports.Node = Node;
exports.DECLARED_FORM = DECLARED_FORM;
exports.EXPRESSED_FORM = EXPRESSED_FORM;
exports.STATEMENT_FORM = STATEMENT_FORM;
exports.Tokenizer = Tokenizer;
exports.Parser = Parser;

return exports;
})();
// CUT>
})();
// <CUT

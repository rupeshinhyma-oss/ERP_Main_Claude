"""
Safe Formula Evaluator for Shipment Planning formula columns.

The "add any calculation manually" feature needs to let an admin type an
arbitrary arithmetic expression (e.g. ``"Mum40 * Rate + 5"``) that gets
evaluated per row, referencing other columns in that row by name. Running
admin-supplied text through Python's ``eval()`` would let anyone with
``planning.column.manage`` execute arbitrary code on the server, so this
module implements a small, explicit, safe expression grammar instead:

- Numeric literals: ``5``, ``3.14``
- Column-name variables: any bare identifier, resolved against the row's
  other cell values (case-sensitive, matched against column names)
- Arithmetic: ``+ - * / ** %`` and unary ``-``
- Parentheses for grouping
- A small allow-listed function set: ``round``, ``abs``, ``min``, ``max``,
  ``sum`` (over a comma-separated argument list, not an iterable literal)

Anything outside that grammar -- attribute access, subscripts, string
literals, comparisons, boolean logic, comprehensions, function
definitions, imports, or any other Python construct -- is rejected before
evaluation ever begins, by walking the parsed AST and refusing to
evaluate any node type not on the allow-list below.
"""

from __future__ import annotations

import ast
import hashlib
import operator
import re
from typing import Any

from app.core.exceptions import BadRequestException

# Real planning column names routinely contain spaces, slashes, parentheses,
# and other characters that aren't valid in a bare Python identifier (e.g.
# "PKG QTY", "UNIT WEIGHT/PKG (KG)", "Mum 1") -- but the AST-based grammar
# below only ever recognizes bare identifiers as variables. Rather than
# requiring admins to rename every column to an identifier-safe name before
# it can be used in a formula, every public entry point in this module
# accepts formulas written with the *actual* column names (optionally
# wrapped in square brackets, e.g. "[Mum 1] * [PKG QTY]", to disambiguate
# from surrounding text) and transparently mangles each real name into a
# safe synthetic identifier before handing the expression to `ast.parse`,
# unmangling error messages back to the original names afterwards.
_BRACKETED_REF = re.compile(r"\[([^\[\]]+)\]")


def _mangle(name: str) -> str:
    """Turn an arbitrary column name into a safe, unique Python identifier."""
    digest = hashlib.sha1(name.encode("utf-8")).hexdigest()[:10]
    return f"_col_{digest}"


def _rewrite_expression(expression: str, *, known_column_names: set[str] | None) -> tuple[str, dict[str, str]]:
    """
    Replace every ``[Column Name]`` reference (and, for backward
    compatibility, every bare identifier that exactly matches a known
    column name) with a mangled safe identifier.

    Returns the rewritten expression plus a mapping of mangled-name ->
    original-name, so callers can translate variables back for error
    messages and for building the ``row_values`` dict passed to
    :func:`evaluate_formula`.
    """
    mapping: dict[str, str] = {}

    def _replace_bracketed(match: re.Match) -> str:
        original = match.group(1)
        mangled = _mangle(original)
        mapping[mangled] = original
        return mangled

    rewritten = _BRACKETED_REF.sub(_replace_bracketed, expression)

    # Backward compatibility: a formula written as "Mum40 * Rate" (no
    # brackets, column names that already happen to be valid identifiers)
    # continues to work exactly as before -- only rewrite bare names when
    # we actually know the sheet's column names, so plain identifiers
    # that aren't column names (a typo, say) still surface as "unknown
    # column reference" rather than silently mangling into nonsense.
    if known_column_names:
        # Sort longest-first so a column named "Mum1" doesn't get
        # partially matched inside a longer identifier like "Mum10".
        for name in sorted(known_column_names, key=len, reverse=True):
            if not name.isidentifier():
                continue
            pattern = re.compile(rf"(?<![\w\]]){re.escape(name)}(?!\w)")
            mangled = _mangle(name)

            def _sub(match: re.Match, _mangled: str = mangled, _name: str = name) -> str:
                mapping[_mangled] = _name
                return _mangled

            rewritten = pattern.sub(_sub, rewritten)

    return rewritten, mapping

_ALLOWED_BINOPS: dict[type, Any] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.FloorDiv: operator.floordiv,
}

_ALLOWED_UNARYOPS: dict[type, Any] = {
    ast.UAdd: operator.pos,
    ast.USub: operator.neg,
}

_ALLOWED_FUNCTIONS: dict[str, Any] = {
    "round": round,
    "abs": abs,
    "min": min,
    "max": max,
    "sum": lambda *args: sum(args),
}

_MAX_EXPRESSION_LENGTH = 2000


class FormulaError(BadRequestException):
    """Raised for any formula that fails to parse, validate, or evaluate safely."""


def _validate_node(node: ast.AST, *, known_names: set[str] | None) -> None:
    """Recursively reject any AST node type/reference not on the allow-list."""
    if isinstance(node, ast.Expression):
        _validate_node(node.body, known_names=known_names)
    elif isinstance(node, ast.BinOp):
        if type(node.op) not in _ALLOWED_BINOPS:
            raise FormulaError(f"Operator {type(node.op).__name__!r} is not allowed in formulas.")
        _validate_node(node.left, known_names=known_names)
        _validate_node(node.right, known_names=known_names)
    elif isinstance(node, ast.UnaryOp):
        if type(node.op) not in _ALLOWED_UNARYOPS:
            raise FormulaError(f"Unary operator {type(node.op).__name__!r} is not allowed in formulas.")
        _validate_node(node.operand, known_names=known_names)
    elif isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name) or node.func.id not in _ALLOWED_FUNCTIONS:
            allowed = ", ".join(sorted(_ALLOWED_FUNCTIONS))
            raise FormulaError(f"Only these functions are allowed in formulas: {allowed}.")
        if node.keywords:
            raise FormulaError("Keyword arguments are not allowed in formulas.")
        for arg in node.args:
            _validate_node(arg, known_names=known_names)
    elif isinstance(node, ast.Constant):
        if not isinstance(node.value, (int, float)):
            raise FormulaError("Only numeric literals are allowed in formulas.")
    elif isinstance(node, ast.Name):
        if known_names is not None and node.id not in known_names:
            raise FormulaError(f"Unknown column reference {node.id!r} in formula.")
    else:
        raise FormulaError(f"{type(node).__name__!r} is not allowed in formulas.")


def validate_formula_syntax(expression: str, *, known_column_names: set[str] | None = None) -> None:
    """
    Parse and validate a formula's syntax without evaluating it.

    Called when an admin saves a formula column, so a typo or disallowed
    construct is rejected immediately rather than surfacing later on
    every row read. ``known_column_names`` is optional here (the column
    being saved may reference a sibling column added moments before this
    validation runs); pass it to also catch references to columns that
    don't exist on the sheet at all.

    Column names containing spaces or other non-identifier characters
    (e.g. "PKG QTY") must be wrapped in square brackets: ``[PKG QTY] * 2``.
    Names that already happen to be valid identifiers (e.g. "Mum40") can
    be written bare, unchanged from the original behavior.
    """
    if not expression or not expression.strip():
        raise FormulaError("Formula expression cannot be empty.")
    if len(expression) > _MAX_EXPRESSION_LENGTH:
        raise FormulaError(f"Formula expression exceeds the {_MAX_EXPRESSION_LENGTH}-character limit.")
    rewritten, mapping = _rewrite_expression(expression, known_column_names=known_column_names)
    try:
        tree = ast.parse(rewritten, mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"Formula has invalid syntax: {exc.msg}") from exc
    # Only mangled names that actually correspond to a *known* column are
    # allowed -- a bracketed reference to a nonexistent column must still
    # fail here as "unknown column reference", not be silently accepted
    # just because it went through the mangling step.
    known_mangled = (
        {_mangle(n) for n in known_column_names} if known_column_names else None
    )
    try:
        _validate_node(tree, known_names=known_mangled)
    except FormulaError as exc:
        raise _unmangle_error(exc, mapping) from exc


def _unmangle_error(exc: FormulaError, mapping: dict[str, str]) -> FormulaError:
    """Rewrite a mangled identifier back to its original column name inside an error message."""
    message = str(exc)
    for mangled, original in mapping.items():
        message = message.replace(repr(mangled), repr(original))
    return FormulaError(message)


def evaluate_formula(expression: str, *, row_values: dict[str, float]) -> float:
    """
    Evaluate a validated formula expression against one row's column values.

    ``row_values`` maps column name -> numeric value for every other
    column in the same row (non-numeric/empty cells are simply absent, so
    referencing one raises a clear "unknown column reference" style error
    rather than silently defaulting to zero and producing a misleading
    result). Column names with spaces/special characters are written in
    the expression as ``[Column Name]``; see :func:`_rewrite_expression`.
    """
    rewritten, mapping = _rewrite_expression(expression, known_column_names=set(row_values.keys()))
    try:
        tree = ast.parse(rewritten, mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"Formula has invalid syntax: {exc.msg}") from exc

    # Build a mangled-name -> value lookup: every mangled reference maps
    # back to an original column name, which is then looked up in
    # row_values exactly as before.
    mangled_values: dict[str, float] = {}
    for mangled, original in mapping.items():
        if original in row_values:
            mangled_values[mangled] = row_values[original]
    # Bare identifiers that were never bracketed/rewritten (the original
    # "Mum40 * Rate" style, no spaces) still resolve directly against
    # row_values, unchanged from the original behavior.
    known_names = set(mangled_values) | set(row_values.keys())
    try:
        _validate_node(tree, known_names=known_names)
    except FormulaError as exc:
        raise _unmangle_error(exc, mapping) from exc

    def _eval(node: ast.AST) -> float:
        if isinstance(node, ast.Expression):
            return _eval(node.body)
        if isinstance(node, ast.BinOp):
            left, right = _eval(node.left), _eval(node.right)
            fn = _ALLOWED_BINOPS[type(node.op)]
            try:
                return fn(left, right)
            except ZeroDivisionError as exc:
                raise FormulaError("Formula divides by zero.") from exc
        if isinstance(node, ast.UnaryOp):
            return _ALLOWED_UNARYOPS[type(node.op)](_eval(node.operand))
        if isinstance(node, ast.Call):
            fn = _ALLOWED_FUNCTIONS[node.func.id]
            return fn(*(_eval(arg) for arg in node.args))
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            if node.id in mangled_values:
                return mangled_values[node.id]
            if node.id in row_values:
                return row_values[node.id]
            original = mapping.get(node.id, node.id)
            raise FormulaError(f"Column {original!r} referenced in formula has no numeric value on this row.")
        raise FormulaError(f"{type(node).__name__!r} is not allowed in formulas.")

    try:
        result = _eval(tree)
    except FormulaError as exc:
        raise _unmangle_error(exc, mapping) from exc
    if not isinstance(result, (int, float)):
        raise FormulaError("Formula did not evaluate to a number.")
    return float(result)
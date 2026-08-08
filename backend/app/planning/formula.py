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
import operator
from typing import Any

from app.core.exceptions import BadRequestException

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
    """
    if not expression or not expression.strip():
        raise FormulaError("Formula expression cannot be empty.")
    if len(expression) > _MAX_EXPRESSION_LENGTH:
        raise FormulaError(f"Formula expression exceeds the {_MAX_EXPRESSION_LENGTH}-character limit.")
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"Formula has invalid syntax: {exc.msg}") from exc
    _validate_node(tree, known_names=known_column_names)


def evaluate_formula(expression: str, *, row_values: dict[str, float]) -> float:
    """
    Evaluate a validated formula expression against one row's column values.

    ``row_values`` maps column name -> numeric value for every other
    column in the same row (non-numeric/empty cells are simply absent, so
    referencing one raises a clear "unknown column reference" style error
    rather than silently defaulting to zero and producing a misleading
    result).
    """
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise FormulaError(f"Formula has invalid syntax: {exc.msg}") from exc
    _validate_node(tree, known_names=set(row_values.keys()))

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
            if node.id not in row_values:
                raise FormulaError(f"Column {node.id!r} referenced in formula has no numeric value on this row.")
            return row_values[node.id]
        raise FormulaError(f"{type(node).__name__!r} is not allowed in formulas.")

    result = _eval(tree)
    if not isinstance(result, (int, float)):
        raise FormulaError("Formula did not evaluate to a number.")
    return float(result)
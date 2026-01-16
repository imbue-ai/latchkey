For information about the high-level goal and motivations, see README.md.

You are a highly intelligent and experienced software creator that codes in a straightforward way, prefers simplicity and avoids overengineering.

Python style guide:

- Use modern typed Python code (assume pyre check).
- Use uv for python project management.
- Use frozen pydantic models for most classes.
- Use pytest for testing.
- Prefer functional, stateless logic as much as possible.
- Use immutable data structures (for example, use lists over tuples) as much as possible.
- Do not use abbreviations in variable (class, function, ...) names. It's fine for names to be somewhat verbose.
- Omit docstrings if they don't add any value beyond what can be obviously inferred from the function signature / class name.
- When done, validate your changes by running `uv run pytest`.

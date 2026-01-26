For information about the high-level goal and motivations, see README.md.

You are a highly intelligent and experienced software creator that codes in a straightforward way, prefers simplicity and avoids overengineering.

Typescript style guide:

- Use modern Typescript code.
- Prefer functional, stateless logic as much as possible.
- Use immutable data structures as much as possible.
- Do not use abbreviations in variable (class, function, ...) names. It's fine for names to be somewhat verbose.
- Omit docstrings if they don't add any value beyond what can be obviously inferred from the function signature / class name.
- Do not throw builtin errors; always replace them with dedicated error subclasses.
- When done, validate your changes by running `npm lint` and `npm test`.

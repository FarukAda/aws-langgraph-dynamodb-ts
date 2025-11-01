# Code of Conduct

## Our Pledge

We as members, contributors, and leaders pledge to make participation in our
community a harassment-free experience for everyone, regardless of age, body
size, visible or invisible disability, ethnicity, sex characteristics, gender
identity and expression, level of experience, education, socio-economic status,
nationality, personal appearance, race, religion, or sexual identity
and orientation.

We pledge to act and interact in ways that contribute to an open, welcoming,
diverse, inclusive, and healthy community.

## Our Standards

Examples of behavior that contributes to a positive environment for our
community include:

* Demonstrating empathy and kindness toward other people
* Being respectful of differing opinions, viewpoints, and experiences
* Giving and gracefully accepting constructive feedback
* Accepting responsibility and apologizing to those affected by our mistakes,
  and learning from the experience
* Focusing on what is best not just for us as individuals, but for the
  overall community

Examples of unacceptable behavior include:

* The use of sexualized language or imagery, and sexual attention or
  advances of any kind
* Trolling, insulting or derogatory comments, and personal or political attacks
* Public or private harassment
* Publishing others' private information, such as a physical or email
  address, without their explicit permission
* Other conduct which could reasonably be considered inappropriate in a
  professional setting

## Enforcement Responsibilities

Project maintainers are responsible for clarifying and enforcing our standards of
acceptable behavior and will take appropriate and fair corrective action in
response to any behavior that they deem inappropriate, threatening, offensive,
or harmful.

Project maintainers have the right and responsibility to remove, edit, or reject
comments, commits, code, wiki edits, issues, and other contributions that are
not aligned to this Code of Conduct, and will communicate reasons for moderation
decisions when appropriate.

## Scope

This Code of Conduct applies within all community spaces, and also applies when
an individual is officially representing the community in public spaces.
Examples of representing our community include using an official e-mail address,
posting via an official social media account, or acting as an appointed
representative at an online or offline event.

## Enforcement

Instances of abusive, harassing, or otherwise unacceptable behavior may be
reported to the project maintainers responsible for enforcement at
info@farukada.com.

All complaints will be reviewed and investigated promptly and fairly.

All project maintainers are obligated to respect the privacy and security of the
reporter of any incident.

## Enforcement Guidelines

Project maintainers will follow these Community Impact Guidelines in determining
the consequences for any action they deem in violation of this Code of Conduct:

### 1. Correction

**Community Impact**: Use of inappropriate language or other behavior deemed
unprofessional or unwelcome in the community.

**Consequence**: A private, written warning from project maintainers, providing
clarity around the nature of the violation and an explanation of why the
behavior was inappropriate. A public apology may be requested.

### 2. Warning

**Community Impact**: A violation through a single incident or series
of actions.

**Consequence**: A warning with consequences for continued behavior. No
interaction with the people involved, including unsolicited interaction with
those enforcing the Code of Conduct, for a specified period of time. This
includes avoiding interactions in community spaces as well as external channels
like social media. Violating these terms may lead to a temporary or
permanent ban.

### 3. Temporary Ban

**Community Impact**: A serious violation of community standards, including
sustained inappropriate behavior.

**Consequence**: A temporary ban from any sort of interaction or public
communication with the community for a specified period of time. No public or
private interaction with the people involved, including unsolicited interaction
with those enforcing the Code of Conduct, is allowed during this period.
Violating these terms may lead to a permanent ban.

### 4. Permanent Ban

**Community Impact**: Demonstrating a pattern of violation of community
standards, including sustained inappropriate behavior,  harassment of an
individual, or aggression toward or disparagement of classes of individuals.

**Consequence**: A permanent ban from any sort of public interaction within
the community.

## Attribution

This Code of Conduct is adapted from the [Contributor Covenant][homepage],
version 2.0, available at
https://www.contributor-covenant.org/version/2/0/code_of_conduct.html.

Community Impact Guidelines were inspired by [Mozilla's code of conduct
enforcement ladder](https://github.com/mozilla/diversity).

[homepage]: https://www.contributor-covenant.org

For answers to common questions about this code of conduct, see the FAQ at
https://www.contributor-covenant.org/faq. Translations are available at
https://www.contributor-covenant.org/translations.
# Contributing to aws-langgraph-dynamodb-ts

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to the project.

## Development Setup

### Prerequisites

- Node.js >= 20.0.0
- npm >= 10.0.0

### Installation

```bash
# Clone the repository
git clone https://github.com/farukada/aws-langgraph-dynamodb-ts.git
cd aws-langgraph-dynamodb-ts

# Install dependencies
npm install

# Run type checking
npm run typecheck

# Run tests
npm test

# Run linting
npm run lint
```

## Development Workflow

### 1. Create a Branch

```bash
git checkout -b feature/your-feature-name
# or
git checkout -b fix/your-bug-fix
```

### 2. Make Changes

- Write clean, readable code
- Follow existing code style
- Add tests for new features
- Update documentation as needed

### 3. Run Quality Checks

```bash
# Type checking
npm run typecheck

# Linting
npm run lint

# Tests with coverage
npm test

# Code duplication check
npm run cpd
```

### 4. Commit Changes

Use clear, descriptive commit messages:

```bash
git commit -m "feat: add new feature X"
git commit -m "fix: resolve issue with Y"
git commit -m "docs: update README for Z"
```

## Code Style

### TypeScript Guidelines

- Use TypeScript strict mode
- Provide explicit return types for functions
- Use interfaces for object shapes
- Avoid `any` types (use `unknown` if necessary)
- Use const assertions where appropriate

### Naming Conventions

- **Files**: kebab-case (`my-file.ts`)
- **Classes**: PascalCase (`MyClass`)
- **Functions**: camelCase (`myFunction`)
- **Constants**: UPPER_SNAKE_CASE (`MY_CONSTANT`)
- **Interfaces**: PascalCase (`MyInterface`)

### Documentation

- Add JSDoc comments for all public APIs
- Include `@param`, `@returns`, and `@throws` tags
- Provide usage examples where helpful

```typescript
/**
 * Brief description of the function
 *
 * @param userId - User identifier
 * @param sessionId - Session identifier
 * @returns Array of messages
 * @throws Error if validation fails
 *
 * @example
 * ```typescript
 * const messages = await getMessages('user-123', 'session-456');
 * ```
 */
export async function getMessages(userId: string, sessionId: string): Promise<BaseMessage[]> {
  // Implementation
}
```

## Testing

### Writing Tests

- Create test files alongside source files with `.test.ts` extension
- Use descriptive test names
- Test both success and failure cases
- Mock external dependencies (DynamoDB, Bedrock)

```typescript
describe('MyFunction', () => {
  it('should handle valid input correctly', () => {
    // Test implementation
  });

  it('should throw error for invalid input', () => {
    expect(() => myFunction(invalidInput)).toThrow();
  });
});
```

### Coverage Requirements

- Minimum 80% coverage for:
  - Branches
  - Functions
  - Statements

## Pull Request Process

### Before Submitting

1. ✅ All tests pass (`npm test`)
2. ✅ Type checking passes (`npm run typecheck`)
3. ✅ Linting passes (`npm run lint`)
4. ✅ Code duplication is minimal (`npm run cpd`)
5. ✅ Documentation is updated
6. ✅ CHANGELOG.md is updated (if applicable)

### PR Title Format

Use conventional commit format:

- `feat: Add new feature`
- `fix: Fix bug in X`
- `docs: Update documentation`
- `refactor: Refactor component Y`
- `test: Add tests for Z`
- `chore: Update dependencies`

### PR Description

Include:

- **What**: Brief description of changes
- **Why**: Reason for changes
- **How**: Implementation approach
- **Testing**: How you tested the changes
- **Breaking Changes**: Any breaking changes (if applicable)

### Example PR Description

```markdown
## What
Adds semantic search support for memory store

## Why
Users requested ability to search memories by similarity

## How
- Integrated Bedrock embeddings
- Added cosine similarity calculation
- Updated search operation to rank by similarity

## Testing
- Added unit tests for embedding generation
- Added integration tests with mock embeddings
- Tested with real Bedrock service

## Breaking Changes
None
```

## Project Structure

```
src/
├── checkpointer/     # Checkpoint saver implementation
│   ├── actions/      # Action handlers
│   ├── types/        # Type definitions
│   └── utils/        # Utilities and validation
├── store/            # Memory store implementation
│   ├── actions/      # Action handlers
│   ├── types/        # Type definitions
│   └── utils/        # Utilities and validation
├── history/          # Chat message history
│   ├── actions/      # Action handlers
│   ├── types/        # Type definitions
│   └── utils/        # Utilities and validation
├── shared/           # Shared utilities
│   └── utils/        # Retry logic, constants, etc.
└── factory.ts        # Factory for creating instances
```

## Release Process

Releases are handled by maintainers. Version numbers follow [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

## Code of Conduct

Please note that this project adheres to a Code of Conduct. By participating, you are expected to uphold this code.

## Questions?

- Open an issue for bugs or feature requests
- Start a discussion for questions or ideas
- Email: info@farukada.com

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing! 🎉


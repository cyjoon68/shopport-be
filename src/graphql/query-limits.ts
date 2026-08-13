import { GraphQLError, Kind } from 'graphql';
import type {
  FieldNode,
  DefinitionNode,
  FragmentDefinitionNode,
  SelectionSetNode,
  ValidationRule,
} from 'graphql';

const fragmentsFrom = (
  definitions: ReadonlyArray<DefinitionNode>,
): ReadonlyMap<string, FragmentDefinitionNode> => {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  return fragments;
};

const nestedDepth = (
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  visited: ReadonlySet<string>,
): number => {
  let maximum = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      maximum = Math.max(
        maximum,
        1 +
          (selection.selectionSet
            ? nestedDepth(selection.selectionSet, fragments, visited)
            : 0),
      );
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      maximum = Math.max(
        maximum,
        nestedDepth(selection.selectionSet, fragments, visited),
      );
    } else if (!visited.has(selection.name.value)) {
      const fragment = fragments.get(selection.name.value);
      if (fragment) {
        maximum = Math.max(
          maximum,
          nestedDepth(
            fragment.selectionSet,
            fragments,
            new Set([...visited, selection.name.value]),
          ),
        );
      }
    }
  }
  return maximum;
};

const requestedFirst = (field: FieldNode): number => {
  const argument = field.arguments?.find(({ name }) => name.value === 'first');
  return argument?.value.kind === Kind.INT
    ? Math.min(Math.max(Number(argument.value.value), 1), 50)
    : 50;
};

const complexityOf = (
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  visited: ReadonlySet<string>,
): number => {
  let total = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      const child = selection.selectionSet
        ? complexityOf(selection.selectionSet, fragments, visited)
        : 0;
      const multiplier = [
        'conversations',
        'searchProducts',
        'savedProducts',
      ].includes(selection.name.value)
        ? requestedFirst(selection)
        : 1;
      total += 1 + child * multiplier;
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      total += complexityOf(selection.selectionSet, fragments, visited);
    } else if (!visited.has(selection.name.value)) {
      const fragment = fragments.get(selection.name.value);
      if (fragment) {
        total += complexityOf(
          fragment.selectionSet,
          fragments,
          new Set([...visited, selection.name.value]),
        );
      }
    }
  }
  return total;
};

export const queryLimitRule =
  (maximumDepth: number, maximumComplexity: number): ValidationRule =>
  (context) => {
    const fragments = fragmentsFrom(context.getDocument().definitions);
    return {
      OperationDefinition: (operation): void => {
        const depth = nestedDepth(operation.selectionSet, fragments, new Set());
        if (depth > maximumDepth) {
          context.reportError(
            new GraphQLError(
              `Query depth ${String(depth)} exceeds ${String(maximumDepth)}`,
            ),
          );
        }
        const complexity = complexityOf(
          operation.selectionSet,
          fragments,
          new Set(),
        );
        if (complexity > maximumComplexity) {
          context.reportError(
            new GraphQLError(
              `Query complexity ${String(complexity)} exceeds ${String(maximumComplexity)}`,
            ),
          );
        }
      },
    };
  };

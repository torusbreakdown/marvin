import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { registerRecipesTools } from '../../src/tools/recipes.js';
import type { ToolContext } from '../../src/types.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: '/tmp/test',
    codingMode: false,
    nonInteractive: false,
    profileDir: '/tmp/profile',
    profile: {
      name: 'test',
      profileDir: '/tmp/profile',
      preferences: {},
      savedPlaces: [],
      chatLog: [],
      ntfySubscriptions: [],
      oauthTokens: {},
      inputHistory: [],
    },
    ...overrides,
  };
}

describe('Recipes Tools', () => {
  let registry: ToolRegistry;
  let ctx: ToolContext;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerRecipesTools(registry);
    ctx = makeCtx();
  });

  describe('recipe_search', () => {
    it('registers the tool', () => {
      expect(registry.get('recipe_search')).toBeDefined();
    });

    it('returns meals from TheMealDB by name', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          meals: [
            { idMeal: '52772', strMeal: 'Teriyaki Chicken Casserole', strCategory: 'Chicken', strArea: 'Japanese', strMealThumb: 'https://example.com/thumb.jpg' },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('recipe_search', { query: 'chicken', search_type: 'name' }, ctx);
      expect(result).toContain('Teriyaki Chicken Casserole');
      expect(result).toContain('Japanese');

      vi.unstubAllGlobals();
    });

    it('returns meals by ingredient', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          meals: [
            { idMeal: '52940', strMeal: 'Brown Stew Chicken', strMealThumb: 'https://example.com/thumb.jpg' },
          ],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('recipe_search', { query: 'chicken', search_type: 'ingredient' }, ctx);
      expect(result).toContain('Brown Stew Chicken');

      vi.unstubAllGlobals();
    });
  });

  describe('recipe_lookup', () => {
    it('registers the tool', () => {
      expect(registry.get('recipe_lookup')).toBeDefined();
    });

    it('returns full recipe with ingredients', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          meals: [{
            idMeal: '52772',
            strMeal: 'Teriyaki Chicken Casserole',
            strCategory: 'Chicken',
            strArea: 'Japanese',
            strInstructions: 'Preheat oven to 350. Cook chicken...',
            strIngredient1: 'soy sauce', strMeasure1: '3/4 cup',
            strIngredient2: 'water', strMeasure2: '1/2 cup',
            strIngredient3: '', strMeasure3: '',
          }],
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await registry.executeTool('recipe_lookup', { meal_id: '52772' }, ctx);
      expect(result).toContain('Teriyaki Chicken Casserole');
      expect(result).toContain('soy sauce');
      expect(result).toContain('3/4 cup');
      expect(result).toContain('Preheat oven');

      vi.unstubAllGlobals();
    });
  });
});

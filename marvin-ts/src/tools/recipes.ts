import { z } from 'zod';
import type { ToolRegistry } from './registry.js';

export function registerRecipesTools(registry: ToolRegistry): void {
  registry.registerTool(
    'recipe_search',
    'Search for recipes by dish name or main ingredient using TheMealDB. Free, no API key needed.',
    z.object({
      query: z.string().describe("Search query — a dish name like 'pasta' or 'chicken curry'"),
      search_type: z.string().default('name').describe("'name' to search by dish name, 'ingredient' to search by main ingredient"),
    }),
    async (args, _ctx) => {
      const url = args.search_type === 'ingredient'
        ? `https://www.themealdb.com/api/json/v1/1/filter.php?i=${encodeURIComponent(args.query)}`
        : `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(args.query)}`;

      const resp = await fetch(url);
      if (!resp.ok) return `Error: TheMealDB request failed (${resp.status})`;
      const data = await resp.json() as any;
      if (!data.meals) return 'No recipes found.';

      return data.meals.slice(0, 10).map((m: any, i: number) => {
        const parts = [`${i + 1}. ${m.strMeal}`];
        if (m.strCategory) parts.push(`   Category: ${m.strCategory}`);
        if (m.strArea) parts.push(`   Cuisine: ${m.strArea}`);
        parts.push(`   ID: ${m.idMeal}`);
        return parts.join('\n');
      }).join('\n\n');
    },
    'always',
  );

  registry.registerTool(
    'recipe_lookup',
    'Get full recipe details by TheMealDB meal ID. Returns ingredients, measurements, and instructions.',
    z.object({
      meal_id: z.string().describe('TheMealDB meal ID from search results'),
    }),
    async (args, _ctx) => {
      const resp = await fetch(`https://www.themealdb.com/api/json/v1/1/lookup.php?i=${args.meal_id}`);
      if (!resp.ok) return `Error: TheMealDB request failed (${resp.status})`;
      const data = await resp.json() as any;
      if (!data.meals?.length) return 'Recipe not found.';
      const m = data.meals[0];

      const parts = [
        `${m.strMeal}`,
        `Category: ${m.strCategory || 'N/A'}`,
        `Cuisine: ${m.strArea || 'N/A'}`,
      ];

      // Collect ingredients
      const ingredients: string[] = [];
      for (let i = 1; i <= 20; i++) {
        const ing = m[`strIngredient${i}`];
        const measure = m[`strMeasure${i}`];
        if (ing && ing.trim()) {
          ingredients.push(`  • ${measure?.trim() || ''} ${ing.trim()}`.trim());
        }
      }
      if (ingredients.length) {
        parts.push('\nIngredients:');
        parts.push(...ingredients);
      }

      if (m.strInstructions) {
        parts.push(`\nInstructions:\n${m.strInstructions}`);
      }
      if (m.strSource) parts.push(`\nSource: ${m.strSource}`);
      if (m.strYoutube) parts.push(`Video: ${m.strYoutube}`);

      return parts.join('\n');
    },
    'always',
  );
}

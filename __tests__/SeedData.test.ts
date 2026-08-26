import { generateSeedData } from '../src/utils/SeedData';
import { buildNormalizedTasks, getTasksArray } from '../src/utils/NormalizedTaskStore';

describe('SeedData & NormalizedStore Scaling Test', () => {
    it('generates 200 tasks, 5 habits, and 7 categories', () => {
        const data = generateSeedData();
        expect(data.tasks.length).toBe(200);
        expect(data.habits.length).toBe(5);
        expect(data.labels.length).toBe(7);
    });

    it('indexes 200 tasks efficiently in normalized store', () => {
        const data = generateSeedData();
        const start = Date.now();
        const normalized = buildNormalizedTasks(data.tasks);
        const duration = Date.now() - start;

        expect(duration).toBeLessThan(50); // Under 50ms to index 200 tasks
        expect(normalized.allIds.length).toBe(200);
        expect(Object.keys(normalized.byId).length).toBe(200);
        expect(normalized.byStatus.active.length + normalized.byStatus.completed.length).toBe(200);

        const flattened = getTasksArray(normalized);
        expect(flattened.length).toBe(200);
    });
});

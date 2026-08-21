/** Enough of R2 for the dashboard Worker: JSON-string get and put. */
export function stubBucket(objects: Record<string, string>): R2Bucket {
  return {
    async get(key: string) {
      const value = objects[key];
      if (value == null) return null;
      return {
        body: value,
        async json() {
          return JSON.parse(value);
        },
      };
    },
    async put(key: string, value: string) {
      objects[key] = value;
      return {};
    },
  } as unknown as R2Bucket;
}

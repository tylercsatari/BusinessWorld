const BuildingRegistry = (() => {
    const modules = {};

    return {
        register(buildingName, module) {
            modules[buildingName.toLowerCase()] = module;
        },
        get(buildingName) {
            return modules[buildingName.toLowerCase()] || null;
        },
        has(buildingName) {
            return buildingName.toLowerCase() in modules;
        }
    };
})();

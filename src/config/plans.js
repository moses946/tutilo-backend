export const planLimits = {
    free: {
        maxFiles: 5,
        maxFileSizeMB: 10,
        maxNotebooks: 5,
    },
    plus: {
        maxFiles: 12,
        maxFileSizeMB: 25,
        maxNotebooks: Infinity, // Use Infinity for unlimited
    }
};

export const modelLimits = {
    free: {
        agentModel:'gemini-2.5-flash',
        thinkingBudget:0,
        vectorDim:512,
        flashcardModel:'gemini-2.5-flash-lite'
    },
    plus: {
        agentModel:'gemini-2.5-flash',
        thinkingBudget:-1,
        vectorDim:784,
        flashcardModel:'gemini-2.5-flash'
    }
}

export function getModelConfig(plan){
    let limits = modelLimits[plan];
    return limits
}
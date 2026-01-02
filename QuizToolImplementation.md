# Quiz Generator Tool Integration Strategy

## Executive Summary

This document outlines the strategy for integrating a quiz generator tool into the Tutilo run agent system. The quiz generator will allow users to request quiz generation through natural language interactions with the AI agent, which will automatically detect the intent and generate contextually relevant quizzes based on the current chat context and retrieved notebook chunks.

## Current System Architecture

### Agent System Overview

The Tutilo backend uses Google's Generative AI (Gemini) with function calling capabilities:

- **Entry Point**: `handleRunAgent()` in `src/models/models.js`
- **Agent Loop**: `agentLoop()` function handles iterative function calling
- **Current Tools**: Only `video_gen` tool is currently integrated
- **Tool Declaration**: Tools are defined in `src/config/types.js` using `Type` schema
- **Intent Detection**: `intentPrompt()` analyzes user requests to determine if tools are needed

### Existing Quiz Generation Infrastructure

The system already has quiz generation capabilities:

1. **`handleQuizGeneration()`** (`src/models/models.js:339-404`)
   - Generates 10-question quizzes from chat chunks
   - Used in chat context
   - Stores quizzes in Firestore `Quizzes` collection
   - Links quizzes to chats via `chatID`

2. **`handleComprehensiveQuizGeneration()`** (`src/models/models.js:551-623`)
   - Generates customizable quizzes from concept data
   - Supports difficulty levels (easy/medium/hard)
   - Supports custom question counts
   - Used in notebook context

3. **Database Schema** (`src/models/query.js:4-13`)
   - Collection: `Quizzes`
   - Structure: `{ chatID: ref, questions: array, dateCreated: timestamp }`
   - Questions format: `{ question: string, choices: string[], answer: string }`

## Integration Strategy

### Phase 1: Function Declaration

**Location**: `src/config/types.js`

**Action**: Add a new function declaration for quiz generation following the pattern of `videoGenFunctionDeclaration`.

**Implementation Details**:

```typescript
export const quizGenFunctionDeclaration = {
  name: 'generate_quiz',
  description: 'Generates a multiple-choice quiz based on the current conversation context and retrieved notebook chunks. Use this when the user explicitly requests a quiz, test, or assessment.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      numberOfQuestions: {
        type: Type.NUMBER,
        description: 'Number of questions to generate. Default is 10. Range: 5-20.',
        minimum: 5,
        maximum: 20
      },
      difficultyLevel: {
        type: Type.STRING,
        description: 'Difficulty level: "easy" (recall), "medium" (application), or "hard" (analysis/inference). Default is "medium".',
        enum: ['easy', 'medium', 'hard']
      },
      topic: {
        type: Type.STRING,
        description: 'Optional: Specific topic or concept to focus the quiz on. If not provided, quiz will cover all retrieved chunks.',
        nullable: true
      }
    },
    required: []
  }
};
```

**Rationale**:
- Follows existing `video_gen` pattern for consistency
- Provides flexibility for user preferences
- Optional parameters allow for smart defaults
- Clear description helps the agent understand when to use the tool

### Phase 2: Intent Detection Enhancement

**Location**: `src/config/types.js` - `intentPrompt()`

**Action**: Update the intent detection prompt to recognize quiz generation requests.

**Current State** (line 145):
```javascript
1. **Tool Analysis**: Does the user explicitly ask to create/generate flashcards or videos?
```

**Updated State**:
```javascript
1. **Tool Analysis**: Does the user explicitly ask to create/generate flashcards, videos, or quizzes/tests/assessments?
   - YES: Set `isInDomain: true`, `retrievalNeeded: true` (to get content for the tool).
```

**Additional Enhancement**: Update the `<AVAILABLE_TOOLS>` section (line 137-141) to include quiz generation:

```javascript
<AVAILABLE_TOOLS>
[
  { "name": "video generator", "description": "Creates a visual video explanation." },
  { "name": "quiz generator", "description": "Generates multiple-choice quizzes for assessment and practice." }
]
</AVAILABLE_TOOLS>
```

**Rationale**:
- Ensures the intent detection model recognizes quiz requests
- Maintains consistency with existing tool detection patterns
- Improves accuracy of tool invocation

### Phase 3: Agent Loop Integration

**Location**: `src/models/models.js` - `agentLoop()` function

**Action**: Add quiz generation handling in the function call processing section (around line 446-504).

**Implementation Details**:

1. **Add to tools array** (line 435-439):
   ```javascript
   tools: [
     {
       functionDeclarations: [
         videoGenFunctionDeclaration,
         quizGenFunctionDeclaration  // NEW
       ]
     }
   ]
   ```

2. **Add function call handler** (after `video_gen` handler, around line 504):
   ```javascript
   if (functionCall.name == 'generate_quiz') {
     try {
       // Extract parameters with defaults
       const numberOfQuestions = functionCall.args.numberOfQuestions || 10;
       const difficultyLevel = functionCall.args.difficultyLevel || 'medium';
       const topic = functionCall.args.topic || null;
       
       // Prepare chunks for quiz generation
       // Convert chatObj.chunks (object) to array format expected by handleQuizGeneration
       const chunksArray = Object.entries(chatObj.chunks || {}).map(([chunkId, text]) => ({
         chunkId: chunkId,
         text: typeof text === 'string' ? text : JSON.stringify(text)
       }));
       
       // Filter by topic if specified
       let filteredChunks = chunksArray;
       if (topic) {
         // Simple keyword matching - could be enhanced with embedding similarity
         filteredChunks = chunksArray.filter(chunk => 
           chunk.text.toLowerCase().includes(topic.toLowerCase())
         );
       }
       
       // Ensure we have chunks to work with
       if (filteredChunks.length === 0) {
         functionResponsePart = {
           name: functionCall.name,
           response: {
             result: "Unable to generate quiz: No relevant content found. Please ensure you have uploaded materials or asked questions about your notebook content first.",
             success: false
           }
         };
       } else {
         // Generate quiz using existing function
         const quizRef = await handleQuizGeneration(chatRef.id, filteredChunks, userId);
         
         if (quizRef) {
           const quizDoc = await quizRef.get();
           const quizData = quizDoc.data();
           
           functionResponsePart = {
             name: functionCall.name,
             response: {
               result: `Successfully generated a ${numberOfQuestions}-question ${difficultyLevel} quiz!`,
               quizId: quizRef.id,
               questionCount: quizData.questions?.length || 0,
               success: true
             }
           };
         } else {
           functionResponsePart = {
             name: functionCall.name,
             response: {
               result: "Quiz generation failed. Please try again.",
               success: false
             }
           };
         }
       }
     } catch (err) {
       console.error("Failed to generate quiz:", err);
       functionResponsePart = {
         name: functionCall.name,
         response: {
           result: `Quiz generation failed: ${err.message}`,
           success: false
         }
       };
     }
   }
   ```

**Rationale**:
- Reuses existing `handleQuizGeneration` function
- Handles edge cases (no chunks, generation failure)
- Provides clear feedback to the agent
- Maintains consistency with `video_gen` error handling pattern

### Phase 4: Enhanced Quiz Generation (Optional Enhancement)

**Location**: `src/models/models.js` - `handleQuizGeneration()`

**Action**: Enhance the existing function to support difficulty levels and custom question counts.

**Current Limitation**: `handleQuizGeneration()` always generates 10 questions and doesn't support difficulty levels.

**Enhancement Options**:

**Option A: Extend Existing Function** (Recommended)
- Add optional parameters: `numberOfQuestions`, `difficultyLevel`
- Update the prompt to incorporate difficulty guidelines
- Maintain backward compatibility with default values

**Option B: Create New Function**
- Create `handleAdaptiveQuizGeneration()` that wraps `handleComprehensiveQuizGeneration`
- Use this for agent-triggered quizzes
- Keep `handleQuizGeneration` for backward compatibility

**Recommendation**: **Option A** - Extend existing function for consistency and code reuse.

**Implementation** (modify `handleQuizGeneration` signature):
```javascript
export const handleQuizGeneration = async (
  chatId, 
  chunks, 
  userId, 
  numberOfQuestions = 10,  // NEW
  difficultyLevel = 'medium'  // NEW
) => {
  // ... existing code ...
  
  // Update prompt to include difficulty and quantity
  const prompt = `Based on the following text, generate a ${numberOfQuestions}-question multiple-choice quiz.
  
  DIFFICULTY LEVEL: ${difficultyLevel}
  - Easy: Focus on direct recall, definitions, and basic identification
  - Medium: Focus on application, interpretation, and connecting ideas
  - Hard: Focus on analysis, inference, and edge cases with plausible distractors
  
  ---
  CONTEXT:
  ${texts}
  ---
  
  RULES:
  1. Generate exactly ${numberOfQuestions} questions
  2. Difficulty should match "${difficultyLevel}" level
  3. ... (rest of existing rules)
  `;
  
  // Update schema to support variable question count
  responseSchema: {
    type: Type.ARRAY,
    items: { /* existing schema */ },
    minItems: numberOfQuestions,
    maxItems: numberOfQuestions
  }
}
```

### Phase 5: Agent Prompt Enhancement

**Location**: `src/config/types.js` - `agentPrompt()`

**Action**: Update the agent prompt to inform it about quiz generation capabilities.

**Addition** (around line 211, in "Output Format" section):
```javascript
## 5. Quiz Generation
- If the user requests a quiz, test, or assessment, use the \`generate_quiz\` tool.
- You can suggest quiz generation proactively when appropriate (e.g., after explaining a complex topic).
- When a quiz is generated, inform the user and guide them on how to access it.
```

**Rationale**:
- Helps the agent understand when to suggest quizzes
- Improves proactive assistance
- Ensures proper user communication about quiz availability

## Data Flow

### Request Flow

1. **User Request**: "Can you create a quiz on photosynthesis?"
2. **Intent Detection**: `intentPrompt()` identifies quiz request → `isInDomain: true`, `retrievalNeeded: true`
3. **RAG Retrieval**: System retrieves relevant chunks about photosynthesis
4. **Agent Loop**: Agent receives context and decides to call `generate_quiz`
5. **Function Call**: Agent invokes `generate_quiz` with parameters
6. **Quiz Generation**: `handleQuizGeneration()` creates quiz using retrieved chunks
7. **Storage**: Quiz saved to Firestore `Quizzes` collection
8. **Response**: Agent informs user quiz is ready and provides access information

### Response Format

The agent will respond with:
- Confirmation message: "I've generated a 10-question quiz on photosynthesis!"
- Quiz metadata: Quiz ID, question count
- Access instructions: "You can access the quiz in the quiz panel or by clicking the quiz icon."

## Error Handling

### Edge Cases

1. **No Chunks Available**
   - **Detection**: `chatObj.chunks` is empty or null
   - **Response**: "I need some content to generate a quiz. Please ask questions about your notebook or upload materials first."

2. **Insufficient Content**
   - **Detection**: Retrieved chunks are too short or irrelevant
   - **Response**: "The available content is too limited to generate a quality quiz. Please provide more context or ask about specific topics."

3. **Generation Failure**
   - **Detection**: `handleQuizGeneration()` returns null or throws error
   - **Response**: "Quiz generation encountered an error. Please try again or contact support."

4. **Invalid Parameters**
   - **Detection**: Agent provides invalid `numberOfQuestions` or `difficultyLevel`
   - **Response**: Use defaults (10 questions, medium difficulty) and log warning

### Error Logging

- Log all quiz generation attempts with parameters
- Log failures with error details for debugging
- Track success/failure rates for monitoring

## Testing Strategy

### Unit Tests

1. **Function Declaration**
   - Verify schema is valid
   - Test parameter validation

2. **Intent Detection**
   - Test various quiz request phrasings
   - Verify `isInDomain` and `retrievalNeeded` flags

3. **Quiz Generation**
   - Test with various chunk configurations
   - Test with different difficulty levels
   - Test edge cases (empty chunks, invalid parameters)

### Integration Tests

1. **End-to-End Flow**
   - User request → Intent detection → RAG → Quiz generation → Storage
   - Verify quiz is accessible via existing retrieval endpoints

2. **Agent Interaction**
   - Test agent's decision to call quiz tool
   - Verify agent's response after quiz generation
   - Test error handling in agent loop

### Manual Testing Scenarios

1. **Happy Path**
   - "Generate a quiz on [topic]" → Verify quiz created and accessible

2. **Proactive Suggestion**
   - After explaining complex topic → Agent suggests quiz → User accepts → Quiz generated

3. **Error Scenarios**
   - Request quiz with no content → Verify appropriate error message
   - Request quiz with invalid parameters → Verify defaults applied

## Performance Considerations

### Latency

- **Quiz Generation**: ~5-10 seconds (similar to flashcard generation)
- **Mitigation**: 
  - Generate quiz asynchronously if needed
  - Provide immediate feedback: "Generating your quiz..."
  - Use WebSocket or polling to notify when ready

### Token Usage

- **Model**: `gemini-2.5-flash` (same as current quiz generation)
- **Estimated Cost**: Similar to existing quiz generation endpoints
- **Optimization**: Limit chunk context to most relevant chunks (already implemented via RAG)

### Database

- **Storage**: Minimal impact (quiz documents are small)
- **Queries**: Existing quiz retrieval endpoints handle access
- **Cleanup**: Consider cleanup strategy for old quizzes (optional)

## Security & Validation

### Input Validation

1. **Function Parameters**
   - Validate `numberOfQuestions` range (5-20)
   - Validate `difficultyLevel` enum values
   - Sanitize `topic` string

2. **User Authorization**
   - Verify user owns the chat/notebook (already handled by middleware)
   - Ensure quiz is linked to correct chat

### Rate Limiting

- Consider rate limits for quiz generation (prevent abuse)
- Track generation frequency per user/chat
- Implement cooldown if needed

## Monitoring & Analytics

### Metrics to Track

1. **Usage Metrics**
   - Number of quiz generation requests
   - Success/failure rates
   - Average generation time
   - Popular difficulty levels and question counts

2. **Quality Metrics**
   - User engagement with generated quizzes
   - Quiz completion rates
   - User feedback on quiz quality

3. **Error Metrics**
   - Error types and frequencies
   - Failed generation reasons

### Logging

- Log all quiz generation attempts with:
  - User ID
  - Chat ID
  - Parameters used
  - Success/failure status
  - Generation time
  - Error details (if failed)

## Future Enhancements

### Phase 6: Advanced Features (Post-MVP)

1. **Adaptive Difficulty**
   - Analyze user's previous quiz performance
   - Automatically adjust difficulty based on mastery level

2. **Topic-Specific Quizzes**
   - Better topic extraction from user requests
   - Multi-topic quiz generation

3. **Quiz Customization**
   - Question types beyond multiple-choice
   - Time limits
   - Shuffle options

4. **Proactive Suggestions**
   - AI suggests quiz generation after explaining concepts
   - Spaced repetition reminders

5. **Quiz Analytics**
   - Track user performance
   - Identify knowledge gaps
   - Suggest review topics

## Implementation Checklist

### Phase 1: Core Integration
- [ ] Add `quizGenFunctionDeclaration` to `src/config/types.js`
- [ ] Update `intentPrompt()` to recognize quiz requests
- [ ] Add quiz tool to `agentLoop()` tools array
- [ ] Implement function call handler in `agentLoop()`
- [ ] Test basic quiz generation flow

### Phase 2: Enhancement
- [ ] Extend `handleQuizGeneration()` with difficulty/quantity parameters
- [ ] Update agent prompt with quiz capabilities
- [ ] Implement comprehensive error handling
- [ ] Add logging and monitoring

### Phase 3: Testing & Refinement
- [ ] Write unit tests
- [ ] Perform integration testing
- [ ] Manual testing with various scenarios
- [ ] Performance testing
- [ ] User acceptance testing

### Phase 4: Documentation & Deployment
- [ ] Update API documentation
- [ ] Create user-facing documentation
- [ ] Deploy to staging environment
- [ ] Monitor and iterate based on feedback

## Dependencies

### Existing Dependencies (No Changes Needed)
- `@google/genai`: Already in use for agent and quiz generation
- `firebase-admin`: Already in use for database operations
- Express: Already in use for routing

### No New Dependencies Required
- All required functionality exists in the codebase
- Quiz generation functions are already implemented
- Database schema supports quiz storage

## Risk Assessment

### Low Risk
- **Code Reuse**: Leveraging existing, tested quiz generation functions
- **Pattern Consistency**: Following established `video_gen` tool pattern
- **Database**: Using existing schema, no migrations needed

### Medium Risk
- **Agent Behavior**: Agent may not always correctly identify quiz requests
  - **Mitigation**: Comprehensive intent detection prompt updates
- **Performance**: Quiz generation adds latency to agent responses
  - **Mitigation**: Async generation option, clear user feedback

### Mitigation Strategies
- Gradual rollout with feature flags
- Comprehensive testing before production
- Monitoring and quick rollback capability
- User feedback collection

## Success Criteria

### Functional Requirements
- ✅ Agent correctly identifies quiz generation requests
- ✅ Quiz is generated with appropriate content from chat context
- ✅ Quiz is stored and accessible via existing endpoints
- ✅ Agent provides clear feedback to user

### Performance Requirements
- ✅ Quiz generation completes within 10 seconds
- ✅ No degradation in agent response time for non-quiz requests
- ✅ Error handling prevents agent loop failures

### User Experience Requirements
- ✅ Natural language quiz requests work seamlessly
- ✅ Users receive clear confirmation when quiz is ready
- ✅ Error messages are helpful and actionable

## Conclusion

This integration strategy provides a clear path to adding quiz generation as a tool in the Tutilo run agent. By following the established patterns and leveraging existing infrastructure, we can implement this feature efficiently while maintaining code quality and system reliability.

The phased approach allows for incremental development and testing, reducing risk and enabling early feedback. The strategy balances feature richness with implementation simplicity, ensuring a smooth user experience while keeping the codebase maintainable.


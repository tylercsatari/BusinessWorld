const data=require('../buildings/jarvis/viral-ideas.json');
const st=data.ideas[0].synthesis_trace;
console.log(JSON.stringify({proof_surface:st.proof_surface, final_rank_diversity:st.final_rank_diversity, diversity_summary:st.diversity_summary}, null, 2));

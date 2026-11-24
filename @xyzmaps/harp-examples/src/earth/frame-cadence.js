// When GPU timers are unavailable, test whether lowering render resolution
// actually improves delivery. A 30 Hz display or CPU-bound camera path can
// otherwise cause a permanent and ineffective quality reduction.
function createFrameCadence() {
    let samples = [], trial, cooldown = 0;
    function reset(level) {
        const stable = trial ? trial.previous : level;
        samples.length = 0;
        trial = undefined;
        cooldown = 0;
        return stable;
    }
    return {
        reset,
        observe(now, interval, level, maxLevel) {
            if (!(interval >= 3 && interval <= 240)) {
                samples.length = 0;
                return level;
            }
            if (now < cooldown) return level;
            samples.push(interval);
            if (samples.length < (trial ? 10 : 16)) return level;
            const median = samples.sort((a,b)=>a-b)[Math.floor(samples.length/2)];
            samples.length = 0;
            if (trial) {
                const improved = trial.lowering ? median < trial.ms*.90 : median < 20;
                if (!improved) level = trial.previous;
                cooldown = now + (improved ? 1200 : 7000);
                trial = undefined;
                return level;
            }
            const lowering = median > 24 && level < maxLevel;
            if (!lowering && !(median < 18 && level > 0)) return level;
            trial = {ms:median, previous:level, lowering};
            // Ignore target reallocations and the first queued frames.
            cooldown = now + 250;
            return lowering ? level+1 : level-1;
        }
    };
}
module.exports={createFrameCadence};

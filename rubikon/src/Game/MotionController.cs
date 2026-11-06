using Source2.Compiler.Simulation;

namespace Source2.Compiler.Game;

/// <summary>
/// What the server gives a motion controller (its IMotionEvent). CPhysThruster's (server vtable 1819ba360): Simulate is
/// vfn 0x10 (180e90eb0), the rest are empty, and Async (vfn 0x28) is false.
/// </summary>
public interface IMotionEvent
{
    /// <summary>vfn 0x28: whether the controller runs after the tick with the tick's time (true) or after each step.</summary>
    bool Async { get; }
    /// <summary>vfn 0: before the bodies.</summary>
    void Begin() { }
    /// <summary>vfn 0x10: a dynamic, awake body.</summary>
    void Simulate(MotionController controller, RnBody body, float dt);
    /// <summary>vfn 0x18: a body that is not (asleep, static or keyframed).</summary>
    void SimulateIdle(MotionController controller, RnBody body, float dt) { }
    /// <summary>vfn 8: after the bodies.</summary>
    void End(float dt) { }
}

/// <summary>
/// vphysics2's CPhysicsMotionController (vtable 1803f9340, created by world slot 0x3e8 18005bb90; rubikon/CS2_RUNTIME.md).
/// After each step CPhysicsWorld_Simulate calls <see cref="Advance"/>: a synchronous controller runs at once with the
/// step's dt (FUN_1800575b0); an asynchronous one adds the dt and runs from <see cref="Apply"/> after the tick
/// (BeginAsyncPostTickJobs, vfn 0x28) with the time it gathered.
/// </summary>
public sealed class MotionController(GameWorld world, IMotionEvent ev)
{
    public readonly IMotionEvent Event = ev;
    /// <summary>+0x30, read from the event when the controller is made.</summary>
    public readonly bool Async = ev.Async;
    /// <summary>+0x34: time gathered for an asynchronous run.</summary>
    public float Gathered;
    /// <summary>+0x20 / +0x18: the attached bodies, the newest first; a removed one leaves a null the next run drops.</summary>
    public readonly List<RnBody?> Bodies = [];

    /// <summary>AttachObject (1800576a0): at the front, once.</summary>
    public void Attach(RnBody body)
    {
        if (!Bodies.Contains(body)) Bodies.Insert(0, body);
    }

    /// <summary>DetachObject (180057780).</summary>
    public void Detach(RnBody body) => Bodies.Remove(body);

    /// <summary>vfn 0x20 (180057560). Returns whether it ran (the world's +0x148 stays clear).</summary>
    public bool Advance(float dt)
    {
        if (Async)
        {
            Gathered = dt + Gathered;
            return false;
        }
        Run(dt);
        return true;
    }

    /// <summary>vfn 0x28 (180057590): an asynchronous controller's run with the gathered time.</summary>
    public void Apply()
    {
        var dt = Gathered;
        Gathered = 0f;
        if (Async) Run(dt);
    }

    // FUN_1800575b0 / the body of 180057590: Begin, each body from the last index down (a null is swapped out with the
    // last), Simulate for a dynamic awake body (+0x54 == 2, +0x249 bit 2 clear), SimulateIdle otherwise, then End
    void Run(float dt)
    {
        Event.Begin();
        for (var i = Bodies.Count - 1; i >= 0; i--)
        {
            var b = Bodies[i];
            if (b == null)
            {
                var n = Bodies.Count;
                if (n > 0)
                {
                    if (i != n - 1) Bodies[i] = Bodies[n - 1];
                    Bodies.RemoveAt(n - 1);
                }
                continue;
            }
            if ((b.State.Flags249 & 4) != 0 || b.State.BodyType != 2) Event.SimulateIdle(this, b, dt);
            else Event.Simulate(this, b, dt);
        }
        Event.End(dt);
    }

    public GameWorld World => world;
}

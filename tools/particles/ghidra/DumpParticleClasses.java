// Decompile every particle function class's own virtual functions (C_OP_*, C_INIT_*, renderers, emitters, constraints)
// from particles.dll, using the RTTI vtables Ghidra recovers: one text file per class in <outDir>, slots the class
// overrides only (a slot whose function equals the base class's same slot is skipped). Also writes index.tsv.
//   analyzeHeadless <proj> <name> -process particles.dll -noanalysis -postScript DumpParticleClasses.java <outDir> [classRegex]
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.address.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.symbol.*;
import ghidra.program.model.mem.*;
import java.io.*;
import java.util.*;
import java.util.regex.*;

public class DumpParticleClasses extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        File out = new File(args.length > 0 ? args[0] : "particle_dump");
        Pattern want = Pattern.compile(args.length > 1 ? args[1] : "^(C_OP_|C_INIT_|C_OP_Render).*");
        out.mkdirs();
        DecompInterface dec = new DecompInterface();
        dec.openProgram(currentProgram);
        Memory mem = currentProgram.getMemory();
        FunctionManager fm = currentProgram.getFunctionManager();
        int ptr = currentProgram.getDefaultPointerSize();

        // class name -> vtable address: from a TSV (name<TAB>0xaddr) written from the PE's RTTI (rtti.py)
        Map<String, Address> vtables = new TreeMap<>();
        for (String line : java.nio.file.Files.readAllLines(new File(args[2]).toPath())) {
            String[] p = line.split("	");
            if (p.length == 2) vtables.put(p[0], toAddr(Long.parseUnsignedLong(p[1].replace("0x", ""), 16)));
        }
        println("vtables: " + vtables.size());
        PrintWriter index = new PrintWriter(new FileWriter(new File(out, "index.tsv")));
        Map<String, List<Address>> slotsOf = new HashMap<>();
        for (Map.Entry<String, Address> e : vtables.entrySet()) slotsOf.put(e.getKey(), readSlots(mem, fm, e.getValue(), ptr));
        // the base each family derives from: the longest CParticleFunction* vtable sharing the most slots
        for (Map.Entry<String, Address> e : vtables.entrySet()) {
            String cls = e.getKey();
            if (!want.matcher(cls).matches()) continue;
            List<Address> slots = slotsOf.get(cls);
            List<Address> base = bestBase(cls, slots, slotsOf);
            StringBuilder sb = new StringBuilder();
            sb.append("// ").append(cls).append("  vtable ").append(e.getValue()).append("  slots ").append(slots.size()).append("\n");
            int own = 0;
            for (int i = 0; i < slots.size(); i++) {
                Address a = slots.get(i);
                if (a == null) continue;
                if (base != null && i < base.size() && a.equals(base.get(i))) continue;
                Function f = fm.getFunctionAt(a);
                if (f == null) f = createFunction(a, null);
                if (f == null) continue;
                DecompileResults r = dec.decompileFunction(f, 60, monitor);
                String c = r != null && r.getDecompiledFunction() != null ? r.getDecompiledFunction().getC() : "/* decompile failed */";
                sb.append("\n// ---- slot ").append(i).append("  ").append(a).append("  ").append(f.getName()).append("\n").append(c);
                own++;
                index.println(cls + "\t" + i + "\t" + a);
            }
            try (PrintWriter w = new PrintWriter(new FileWriter(new File(out, cls + ".c")))) { w.print(sb); }
            println(cls + ": " + own + " own slots");
        }
        index.close();
        dec.dispose();
    }

    List<Address> readSlots(Memory mem, FunctionManager fm, Address vt, int ptr) throws Exception {
        List<Address> slots = new ArrayList<>();
        for (int i = 0; i < 96; i++) {
            Address p = vt.add((long) i * ptr);
            long v = ptr == 8 ? mem.getLong(p) : mem.getInt(p) & 0xffffffffL;
            Address a = toAddr(v);
            MemoryBlock b = mem.getBlock(a);
            if (b == null || !b.isExecute()) break;
            // the next symbol is the next vtable: stop there
            slots.add(a);
        }
        return slots;
    }

    List<Address> bestBase(String cls, List<Address> slots, Map<String, List<Address>> all) {
        List<Address> best = null; int bestShared = -1;
        for (Map.Entry<String, List<Address>> e : all.entrySet()) {
            if (!e.getKey().startsWith("CParticleFunction")) continue;
            List<Address> b = e.getValue(); int shared = 0;
            for (int i = 0; i < Math.min(b.size(), slots.size()); i++) if (b.get(i).equals(slots.get(i))) shared++;
            if (shared > bestShared) { bestShared = shared; best = b; }
        }
        return best;
    }
}
